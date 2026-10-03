#!/usr/bin/env python3
"""Bounded, one-request-at-a-time document worker.

The worker has no Agent loop, provider credentials, approval authority, or
Runtime state. It receives a JSON object, performs one bounded operation under
HELM_WORKSPACE_ROOT, and emits one JSON response with a redacted artifact
receipt. Optional DOCX/XLSX/PDF dependencies are detected per operation.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import zipfile
from html import escape
from pathlib import Path
from typing import Any

MAX_BYTES = 1_000_000
VERSION = "0.2.0"


def response(request_id: str, *, ok: bool, result: Any = None, error: str | None = None, receipt: dict[str, Any] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"id": request_id, "ok": ok}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = error or "worker_error"
    if receipt is not None:
        payload["receipt"] = receipt
    return payload


def workspace_root() -> Path:
    return Path(os.environ.get("HELM_WORKSPACE_ROOT", os.getcwd())).expanduser().resolve()


def safe_path(raw_path: Any, *, must_exist: bool = False) -> Path:
    if not isinstance(raw_path, str) or not raw_path or "\x00" in raw_path:
        raise ValueError("path_required")
    root = workspace_root()
    candidate = (root / raw_path).resolve(strict=False)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("path_outside_workspace") from exc
    if candidate.exists() and candidate.is_symlink():
        raise ValueError("symlink_rejected")
    if must_exist and not candidate.is_file():
        raise ValueError("file_not_found")
    if candidate.exists() and candidate.stat().st_size > MAX_BYTES:
        raise ValueError("file_exceeds_bound")
    return candidate


def artifact(path: Path, *, operation: str, source_run_id: Any = None, limitations: list[str] | None = None) -> dict[str, Any]:
    data = path.read_bytes()
    if len(data) > MAX_BYTES:
        raise ValueError("artifact_exceeds_bound")
    relative_path = path.relative_to(workspace_root()).as_posix()
    return {
        "type": path.suffix.lower().lstrip(".") or "file",
        "path": relative_path,
        "hash": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "operation": operation,
        "sourceRunId": source_run_id,
        "workerVersion": VERSION,
        "limitations": limitations or [],
    }


def receipt(path: Path, *, operation: str, request: dict[str, Any], limitations: list[str] | None = None) -> dict[str, Any]:
    return {"worker": "document-worker", "workerVersion": VERSION, "operation": operation, "sideEffect": "known", "artifact": artifact(path, operation=operation, source_run_id=request.get("runId"), limitations=limitations)}


def handle(request: dict[str, Any]) -> dict[str, Any]:
    request_id = str(request.get("id", "unknown"))
    operation = request.get("operation")
    if operation == "health":
        return response(request_id, ok=True, result={"worker": "document-worker", "version": VERSION})
    try:
        if operation == "inspect":
            path = safe_path(request.get("path"), must_exist=True)
            return response(request_id, ok=True, result={"path": path.relative_to(workspace_root()).as_posix(), "suffix": path.suffix.lower(), "size": path.stat().st_size}, receipt=receipt(path, operation="inspect", request=request))
        if operation == "docx_create":
            path = safe_path(request.get("path"))
            paragraphs = request.get("paragraphs", [])
            if not isinstance(paragraphs, list) or not all(isinstance(item, str) for item in paragraphs) or len(paragraphs) > 200:
                return response(request_id, ok=False, error="paragraphs_invalid")
            path.parent.mkdir(parents=True, exist_ok=True)
            write_minimal_docx(path, [str(item)[:4_000] for item in paragraphs])
            return response(request_id, ok=True, result={"paragraphs": len(paragraphs)}, receipt=receipt(path, operation="docx_create", request=request))
        if operation in {"xlsx_read_range", "xlsx_write_range"}:
            return handle_xlsx(request, request_id, operation)
        if operation == "pdf_extract":
            return handle_pdf(request, request_id)
        return response(request_id, ok=False, error="unsupported_operation")
    except ImportError as exc:
        return response(request_id, ok=False, error=f"dependency_missing:{exc.name or 'optional'}")
    except (OSError, ValueError, KeyError) as exc:
        return response(request_id, ok=False, error=str(exc))
    except Exception:
        return response(request_id, ok=False, error="worker_operation_failed")


def handle_xlsx(request: dict[str, Any], request_id: str, operation: str) -> dict[str, Any]:
    from openpyxl import load_workbook

    path = safe_path(request.get("path"), must_exist=operation == "xlsx_read_range")
    sheet = request.get("sheet")
    cell = request.get("cell")
    if not isinstance(sheet, str) or not isinstance(cell, str):
        return response(request_id, ok=False, error="sheet_and_cell_required")
    if operation == "xlsx_read_range":
        workbook = load_workbook(path, read_only=True, data_only=False)
        if sheet not in workbook.sheetnames:
            return response(request_id, ok=False, error="sheet_not_found")
        value = workbook[sheet][cell].value
        return response(request_id, ok=True, result={"sheet": sheet, "cell": cell, "value": value}, receipt=receipt(path, operation=operation, request=request))
    value = request.get("value")
    if isinstance(value, (dict, list)):
        return response(request_id, ok=False, error="cell_value_invalid")
    if not path.exists():
        return response(request_id, ok=False, error="file_not_found")
    workbook = load_workbook(path)
    if sheet not in workbook.sheetnames:
        return response(request_id, ok=False, error="sheet_not_found")
    workbook[sheet][cell] = value
    workbook.save(path)
    return response(request_id, ok=True, result={"sheet": sheet, "cell": cell}, receipt=receipt(path, operation=operation, request=request))


def handle_pdf(request: dict[str, Any], request_id: str) -> dict[str, Any]:
    from pypdf import PdfReader

    path = safe_path(request.get("path"), must_exist=True)
    reader = PdfReader(str(path))
    pages: list[dict[str, Any]] = []
    for index, page in enumerate(reader.pages[:100]):
        text = (page.extract_text() or "").strip()
        pages.append({"page": index + 1, "text": text[:10_000], "hasTextLayer": bool(text)})
    if not any(page["hasTextLayer"] for page in pages):
        return response(request_id, ok=False, error="unknown_text_layer", receipt={"worker": "document-worker", "operation": "pdf_extract", "sideEffect": "none", "limitations": ["No text layer was found; OCR is not enabled in this worker."]})
    return response(request_id, ok=True, result={"pages": pages, "extraction": "text-layer"}, receipt=receipt(path, operation="pdf_extract", request=request, limitations=["Scanned pages without a text layer are not OCRed."]))


def write_minimal_docx(path: Path, paragraphs: list[str]) -> None:
    document = "".join(f"<w:p><w:r><w:t xml:space=\"preserve\">{escape(text)}</w:t></w:r></w:p>" for text in paragraphs)
    content_types = """<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"""
    rels = """<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"""
    document_xml = f"""<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{document}<w:sectPr/></w:body></w:document>"""
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", rels)
        archive.writestr("word/document.xml", document_xml)


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request_must_be_object")
            payload = handle(request)
        except Exception:
            payload = response("unknown", ok=False, error="request_invalid")
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

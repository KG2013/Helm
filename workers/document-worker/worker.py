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
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET
from html import escape
from pathlib import Path
from typing import Any

MAX_BYTES = 1_000_000
VERSION = "0.3.0"
MAX_XLSX_CELLS = 1_000


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


def receipt(path: Path, *, operation: str, request: dict[str, Any], side_effect: str = "known", limitations: list[str] | None = None, checks: dict[str, str] | None = None, target: dict[str, Any] | None = None) -> dict[str, Any]:
    value: dict[str, Any] = {"worker": "document-worker", "workerVersion": VERSION, "operation": operation, "sideEffect": side_effect, "artifact": artifact(path, operation=operation, source_run_id=request.get("runId"), limitations=limitations)}
    if checks is not None:
        value["checks"] = checks
    if target is not None:
        value["target"] = target
    return value


def handle(request: dict[str, Any]) -> dict[str, Any]:
    request_id = str(request.get("id", "unknown"))
    operation = request.get("operation")
    if operation == "health":
        return response(request_id, ok=True, result={"worker": "document-worker", "version": VERSION})
    try:
        if operation == "inspect":
            path = safe_path(request.get("path"), must_exist=True)
            return response(request_id, ok=True, result={"path": path.relative_to(workspace_root()).as_posix(), "suffix": path.suffix.lower(), "size": path.stat().st_size}, receipt=receipt(path, operation="inspect", request=request, side_effect="none"))
        if operation == "docx_create":
            path = safe_path(request.get("path"))
            paragraphs = request.get("paragraphs", [])
            if not isinstance(paragraphs, list) or not all(isinstance(item, str) for item in paragraphs) or len(paragraphs) > 200:
                return response(request_id, ok=False, error="paragraphs_invalid")
            path.parent.mkdir(parents=True, exist_ok=True)
            write_minimal_docx(path, [str(item)[:4_000] for item in paragraphs])
            checks, limitations = verify_docx(path, [str(item)[:4_000] for item in paragraphs])
            docx_receipt = receipt(path, operation="docx_create", request=request, limitations=limitations, checks=checks)
            if any(status in {"unknown", "conflict"} for status in checks.values()):
                docx_receipt["verification"] = "unknown"
            if checks.get("structure") != "passed" or checks.get("content") != "passed":
                return response(request_id, ok=False, error="docx_verification_unknown", receipt=docx_receipt)
            return response(request_id, ok=True, result={"paragraphs": len(paragraphs), "checks": checks}, receipt=docx_receipt)
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

    path = safe_path(request.get("path"), must_exist=True)
    sheet = request.get("sheet")
    selector = xlsx_selector(request)
    if not isinstance(sheet, str) or selector is None:
        return response(request_id, ok=False, error="sheet_and_cell_or_range_required")
    if operation == "xlsx_read_range":
        workbook = load_workbook(path, read_only=True, data_only=False)
        if sheet not in workbook.sheetnames:
            return response(request_id, ok=False, error="sheet_not_found")
        value = xlsx_values(workbook[sheet], selector)
        target = {"sheet": sheet, "selector": selector, "cells": xlsx_cells(selector)}
        checks = {"target": "passed"}
        return response(request_id, ok=True, result={"sheet": sheet, "selector": selector, "value": value, "checks": checks}, receipt=receipt(path, operation=operation, request=request, side_effect="none", checks=checks, target=target))
    workbook = load_workbook(path, data_only=False)
    if sheet not in workbook.sheetnames:
        return response(request_id, ok=False, error="sheet_not_found")
    worksheet = workbook[sheet]
    before = xlsx_snapshot(workbook)
    before_target = xlsx_values(worksheet, selector)
    try:
        expected = xlsx_write_values(worksheet, selector, request)
    except ValueError as exc:
        return response(request_id, ok=False, error=str(exc))
    workbook.save(path)
    after_workbook = load_workbook(path, data_only=False)
    after = xlsx_snapshot(after_workbook)
    actual = xlsx_values(after_workbook[sheet], selector)
    target_passed = actual == expected
    scope_passed = before is not None and after is not None and changed_outside_target(before, after, sheet, selector) == []
    checks = {"target": "passed" if target_passed else "conflict", "scope": "passed" if scope_passed else "unknown" if before is None or after is None else "conflict"}
    target = {"sheet": sheet, "selector": selector, "cells": xlsx_cells(selector), "before": before_target, "after": actual}
    result = {"sheet": sheet, "selector": selector, "value": actual, "checks": checks}
    limitations = [] if scope_passed else ["Workbook scope could not be fully compared; unauthorized changes remain unverified."]
    return response(request_id, ok=True, result=result, receipt=receipt(path, operation=operation, request=request, checks=checks, target=target, limitations=limitations))


def handle_pdf(request: dict[str, Any], request_id: str) -> dict[str, Any]:
    from pypdf import PdfReader

    path = safe_path(request.get("path"), must_exist=True)
    reader = PdfReader(str(path))
    pages: list[dict[str, Any]] = []
    for index, page in enumerate(reader.pages[:100]):
        text = (page.extract_text() or "").strip()
        pages.append({"page": index + 1, "text": text[:10_000], "hasTextLayer": bool(text), "source": {"path": path.relative_to(workspace_root()).as_posix(), "page": index + 1}})
    complete = bool(pages) and all(page["hasTextLayer"] for page in pages)
    checks = {"coverage": "passed" if complete else "unknown", "sources": "passed" if pages else "unknown"}
    limitations = [] if complete else ["One or more pages have no text layer; OCR is not enabled in this worker."]
    pdf_receipt = receipt(path, operation="pdf_extract", request=request, side_effect="none", limitations=limitations, checks=checks, target={"pages": [page["page"] for page in pages]})
    result = {"pages": pages, "extraction": "text-layer", "checks": checks}
    if not complete:
        pdf_receipt["verification"] = "unknown"
        return response(request_id, ok=False, result=result, error="unknown_text_layer", receipt=pdf_receipt)
    return response(request_id, ok=True, result=result, receipt=pdf_receipt)


def verify_docx(path: Path, paragraphs: list[str]) -> tuple[dict[str, str], list[str]]:
    """Validate package/XML/content; rendering needs an external office renderer."""
    limitations: list[str] = []
    structure = "passed"
    content = "passed"
    try:
        with zipfile.ZipFile(path) as archive:
            required = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
            if not required.issubset(set(archive.namelist())) or archive.testzip() is not None:
                structure = "conflict"
            else:
                root = ET.fromstring(archive.read("word/document.xml"))
                namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
                found = ["".join(node.itertext()) for node in root.iter(f"{namespace}p")]
                if found != paragraphs:
                    content = "conflict"
    except (OSError, ET.ParseError, zipfile.BadZipFile, KeyError):
        structure = "conflict"
    rendering = "unknown"
    if shutil.which("soffice") or shutil.which("libreoffice"):
        limitations.append("A renderer is available but rendering was not invoked by this bounded operation.")
    else:
        limitations.append("No office renderer is available; visual rendering remains unverified.")
    return {"structure": structure, "content": content, "rendering": rendering}, limitations


def xlsx_selector(request: dict[str, Any]) -> str | None:
    cell = request.get("cell")
    range_name = request.get("range")
    if (cell is None) == (range_name is None):
        return None
    selector = cell if isinstance(cell, str) else range_name
    if not isinstance(selector, str) or not selector or ":" in selector and selector.count(":") != 1:
        return None
    try:
        from openpyxl.utils.cell import range_boundaries
        min_col, min_row, max_col, max_row = range_boundaries(selector)
    except ValueError:
        return None
    cell_count = (max_col - min_col + 1) * (max_row - min_row + 1)
    if min_col < 1 or min_row < 1 or cell_count > MAX_XLSX_CELLS:
        return None
    return selector


def xlsx_cells(selector: str) -> list[str]:
    from openpyxl.utils.cell import get_column_letter, range_boundaries
    min_col, min_row, max_col, max_row = range_boundaries(selector)
    return [f"{get_column_letter(col)}{row}" for row in range(min_row, max_row + 1) for col in range(min_col, max_col + 1)]


def xlsx_values(worksheet: Any, selector: str) -> Any:
    from openpyxl.utils.cell import range_boundaries
    min_col, min_row, max_col, max_row = range_boundaries(selector)
    values = [[worksheet.cell(row=row, column=column).value for column in range(min_col, max_col + 1)] for row in range(min_row, max_row + 1)]
    if min_col == max_col and min_row == max_row:
        return values[0][0]
    return values


def xlsx_write_values(worksheet: Any, selector: str, request: dict[str, Any]) -> Any:
    from openpyxl.utils.cell import range_boundaries
    min_col, min_row, max_col, max_row = range_boundaries(selector)
    if min_col == max_col and min_row == max_row:
        value = request.get("value")
        if isinstance(value, (dict, list)):
            raise ValueError("cell_value_invalid")
        worksheet.cell(row=min_row, column=min_col).value = value
        return value
    values = request.get("values")
    if not isinstance(values, list) or len(values) != max_row - min_row + 1 or any(not isinstance(row, list) or len(row) != max_col - min_col + 1 for row in values):
        raise ValueError("range_values_invalid")
    for row_offset, row in enumerate(values):
        for col_offset, value in enumerate(row):
            if isinstance(value, (dict, list)):
                raise ValueError("cell_value_invalid")
            worksheet.cell(row=min_row + row_offset, column=min_col + col_offset).value = value
    return values


def xlsx_snapshot(workbook: Any) -> dict[str, Any] | None:
    snapshot: dict[str, Any] = {}
    count = 0
    for sheet in workbook.worksheets:
        if sheet.max_row * sheet.max_column > MAX_XLSX_CELLS:
            return None
        for row in sheet.iter_rows(min_row=1, max_row=sheet.max_row, min_col=1, max_col=sheet.max_column):
            for cell in row:
                snapshot[f"{sheet.title}!{cell.coordinate}"] = cell.value
                count += 1
                if count > MAX_XLSX_CELLS:
                    return None
    return snapshot


def changed_outside_target(before: dict[str, Any], after: dict[str, Any], sheet: str, selector: str) -> list[str]:
    target = {f"{sheet}!{cell}" for cell in xlsx_cells(selector)}
    changed: list[str] = []
    for key in set(before) | set(after):
        if key not in target and before.get(key) != after.get(key):
            changed.append(key)
    return changed


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
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=json_default) + "\n")
        sys.stdout.flush()
    return 0


def json_default(value: Any) -> str:
    """Keep valid XLSX date/time values from crashing the JSONL process."""
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        return str(isoformat())
    return str(value)


if __name__ == "__main__":
    raise SystemExit(main())

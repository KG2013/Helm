#!/usr/bin/env python3
"""Small JSONL document-worker seam for Helm.

The worker is intentionally not an Agent runtime. It accepts a request, performs a
bounded document operation, and emits one structured response. P0 starts with health
and inspect operations; DOCX/XLSX/PDF adapters can be added behind this seam.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def response(request_id: str, *, ok: bool, result: Any = None, error: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"id": request_id, "ok": ok}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = error or "worker_error"
    return payload


def handle(request: dict[str, Any]) -> dict[str, Any]:
    request_id = str(request.get("id", "unknown"))
    operation = request.get("operation")
    if operation == "health":
        return response(request_id, ok=True, result={"worker": "document-worker", "version": "0.1.0"})
    if operation == "inspect":
        raw_path = request.get("path")
        if not isinstance(raw_path, str) or not raw_path:
            return response(request_id, ok=False, error="path_required")
        path = Path(raw_path).expanduser()
        if not path.is_file():
            return response(request_id, ok=False, error="file_not_found")
        return response(
            request_id,
            ok=True,
            result={"path": str(path), "suffix": path.suffix.lower(), "size": path.stat().st_size},
        )
    return response(request_id, ok=False, error="unsupported_operation")


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request_must_be_object")
            payload = handle(request)
        except Exception as exc:  # keep the protocol alive for the next request
            payload = response("unknown", ok=False, error=str(exc))
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

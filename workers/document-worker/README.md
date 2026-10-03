# Document Worker

The worker is a bounded JSONL sidecar. It has no Agent loop, provider credential, approval authority, or Runtime state. Set `HELM_WORKSPACE_ROOT` and send one request per line.

Supported operations:

- `health`
- `inspect`
- `docx_create` with `path` and bounded `paragraphs`. The receipt checks the DOCX package and paragraph content; `rendering` stays `unknown` until a renderer is explicitly run.
- `xlsx_read_range` / `xlsx_write_range` with `path`, `sheet`, and a single `cell` or bounded `range`. Write receipts include target values and a before/after snapshot comparison; an oversized workbook returns an `unknown` scope check.
- `pdf_extract` for text-layer extraction. Each page carries a page source, and complete text-layer coverage is required; scanned or partially scanned PDFs return `unknown_text_layer` and are not treated as verified OCR.

Successful file operations return a relative Artifact path, SHA-256, source `runId` when supplied, worker version, checks, and limitations. Paths are canonicalized under the workspace root; symlinks, traversal, oversized files, and unsupported values fail closed. Optional dependencies are reported as `dependency_missing:<name>`.

Run the worker contract tests with:

```bash
python3 -m unittest discover -s workers/document-worker/tests -v
```

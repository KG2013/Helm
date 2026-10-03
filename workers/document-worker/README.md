# Document Worker

The worker is a bounded JSONL sidecar. It has no Agent loop, provider credential, approval authority, or Runtime state. Set `HELM_WORKSPACE_ROOT` and send one request per line.

Supported operations:

- `health`
- `inspect`
- `docx_create` with `path` and bounded `paragraphs`. The receipt checks the DOCX package and paragraph content, then invokes `soffice` or `libreoffice` in a temporary directory with a bounded timeout when one is available. The rendering check proves bounded PDF conversion and opening; pixel-level comparison is outside this worker. If no renderer is available, `rendering` is `unknown` and delivery must remain blocked.
- `xlsx_read_range` / `xlsx_write_range` with `path`, `sheet`, and a single `cell` or bounded `range`. Write receipts include target values and a before/after snapshot comparison; an oversized workbook returns an `unknown` scope check.
- `pdf_extract` for text-layer extraction (bounded to 100 pages). Each page carries a page source and extraction mode. Pages without a text layer use `pdftoppm` plus `tesseract` when both commands are available; OCR pages include confidence and engine metadata. Missing commands, timeouts, empty text, confidence below `0.5`, or a file beyond the page bound return `ocr_unavailable`/UNKNOWN coverage, so scanned PDFs are never treated as verified by fallback.

File operations return a relative Artifact path, SHA-256, source `runId` when supplied, worker version, checks, and limitations, including evidence for an UNKNOWN result. Paths are canonicalized under the workspace root; symlinks, traversal, oversized files, and unsupported values fail closed. Worker subprocesses receive only locale, temporary-directory, and executable-path environment values; provider credentials are not forwarded. Optional Python dependencies are reported as `dependency_missing:<name>`.

Run the worker contract tests with:

```bash
python3 -m unittest discover -s workers/document-worker/tests -v
```

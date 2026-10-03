# Document Worker

The worker is a bounded JSONL sidecar. It has no Agent loop, provider credential, approval authority, or Runtime state. Set `HELM_WORKSPACE_ROOT` and send one request per line.

Supported operations:

- `health`
- `inspect`
- `docx_create` with `path` and bounded `paragraphs`
- `xlsx_read_range` / `xlsx_write_range` with `path`, `sheet`, and `cell`
- `pdf_extract` for text-layer extraction; scanned or empty text returns `unknown_text_layer` and is not treated as verified OCR

Successful file operations return a relative Artifact path, SHA-256, source `runId` when supplied, worker version, and limitations. Paths are canonicalized under the workspace root; symlinks, traversal, oversized files, and unsupported values fail closed. Optional dependencies are reported as `dependency_missing:<name>`.

Run the worker contract tests with:

```bash
python3 -m unittest discover -s workers/document-worker/tests -v
```

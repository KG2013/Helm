---
status: accepted
---

# Use SQLite events as the local recovery source and keep document processing outside the Agent loop

Helm will use SQLite for queryable task/session/run state and an append-only event ledger for durable facts, with JSONL export and file-backed artifacts for inspection and large outputs. DOCX/XLSX/PDF processing may run in a controlled Python worker, but that worker has no Agent loop, provider credentials, or approval authority. This keeps recovery and audit in one local store while allowing mature document tooling without giving a sidecar control over execution policy.

The alternatives were chat transcripts as state, a file-only ledger, or a Python-owned orchestration runtime. Chat history is insufficient for recovery; file-only state makes queries and concurrent UI/CLI access fragile; a second orchestration owner would split lifecycle, approval, and audit semantics.

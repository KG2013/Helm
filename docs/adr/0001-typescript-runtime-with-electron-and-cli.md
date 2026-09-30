---
status: accepted
---

# Own the TypeScript runtime and expose it through Electron and CLI

Helm will own the task loop, state transitions, permission decisions, and delivery protocol in a TypeScript/Node runtime. The first product surfaces will be an Electron + React + Vite desktop app and a CLI that call the same runtime package. This preserves one task semantic and one safety implementation while keeping the UI replaceable; an independent local runtime process remains a future deployment form for long-running work.

The alternatives were a separate desktop runtime and CLI runtime, or adopting the DeepSeek Harness core. The former would duplicate semantics and audit behavior; the latter would reduce initial work but make Helm’s core lifecycle and policy depend on an upstream developer preview.

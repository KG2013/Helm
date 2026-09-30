---
status: accepted
---

# Keep provider secrets in Keychain and make execution isolation layered

Helm will store DeepSeek, Zhipu, and Kimi credentials in macOS Keychain and keep only references and availability metadata in SQLite. P0 will use layered execution: workspace path guards and restricted document workers for local file operations, plus a replaceable sandbox backend for code and shell. A missing or unavailable sandbox fails closed. This separates credential authority and execution authority from model-visible context while keeping a path to stronger container or microVM backends.

The alternatives were plaintext configuration, SQLite secrets, full host execution, or making Docker the only P0 backend. Plaintext and SQLite increase exposure; full host execution weakens containment; a container-only desktop path adds setup friction before the core task loop is proven.

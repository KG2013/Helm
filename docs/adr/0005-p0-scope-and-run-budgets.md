---
status: accepted
---

# Keep P0 local, single-agent, and budgeted

P0 will support a single-agent local coding and document workflow on macOS, with DeepSeek, Zhipu, and Kimi providers, a desktop workbench, CLI, local DOCX/XLSX/PDF processing, evidence-based verifiers, and bounded Runs. Each Run defaults to at most 30 Steps, 15 minutes, configurable token/cost limits, and one reviewer round. Multi-user accounts, remote execution, external system writes, GUI automation, network A2A, marketplaces, and automatic experience mutation remain outside P0.

This boundary keeps the first implementation measurable and reversible. Expanding the surface before the local loop, approval path, recovery, and verifier evidence work would make failures impossible to attribute to the model, Harness, tool, or environment.

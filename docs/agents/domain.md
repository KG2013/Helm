# Domain Docs

Helm uses a single-context domain documentation layout.

## Before exploring

- Read `CONTEXT.md` at the repository root for the domain glossary.
- Read the relevant records in `docs/adr/` before changing a decisioned area.
- Use the glossary vocabulary in issue titles, ticket descriptions, test names, and implementation plans.
- If a change appears to conflict with an accepted ADR, surface the conflict explicitly instead of silently overriding it.

## Layout

The root `CONTEXT.md` contains the shared domain glossary and `docs/adr/` contains system-wide decisions. The pnpm packages share this context; they do not currently have separate context maps or scoped ADR directories.

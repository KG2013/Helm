# Helm Desktop

Electron + React + Vite workbench for the local Helm runtime. The center is conversation-first, with an embedded execution card and a composer connected through typed preload/IPC to RuntimeFacade and a deterministic MockProvider.

From the repository root:

```bash
pnpm --filter @helm/desktop dev       # Vite + Electron with the local dev server
pnpm --filter @helm/desktop build     # Typecheck, bundle renderer and Electron main/preload
pnpm --filter @helm/desktop start     # Open the built renderer in Electron
```

The renderer receives only the narrow API exposed by the preload. Node integration is disabled and context isolation, sandboxing, and an IPC allowlist are enabled in the Electron window. Current IPC handlers expose runtime info, task submission, Run snapshot, pause/resume/cancel, approval resolution, and ordered Run events. Browser preview can show the UI but does not provide Electron preload or IPC. The current slice still uses an in-memory ledger and MockProvider. See [desktop/runtime boundary](../../docs/design/desktop-runtime-boundary.md).

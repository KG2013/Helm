# Helm Desktop

Electron + React + Vite workbench shell for the local Helm runtime. The current renderer is a static interaction demo: the center is conversation-first, with an embedded execution card and a composer; it is not yet connected to Runtime or a real Provider.

From the repository root:

```bash
pnpm --filter @helm/desktop dev       # Vite + Electron with the local dev server
pnpm --filter @helm/desktop build     # Typecheck, bundle renderer and Electron main/preload
pnpm --filter @helm/desktop start     # Open the built renderer in Electron
```

The renderer receives only the narrow API exposed by `src/preload/preload.ts`. Node integration is disabled and context isolation, sandboxing, and an IPC allowlist are enabled in the Electron window. Current IPC handlers expose runtime info and an approval placeholder; runtime control and `run:event` publishing are planned. Browser preview can show the UI but does not provide Electron preload or IPC. See [desktop/runtime boundary](../../docs/design/desktop-runtime-boundary.md).

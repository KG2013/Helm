# Helm Desktop

Electron + React + Vite workbench for the local Helm runtime. The renderer uses a conversation-first three-column layout: the left rail holds workspace and sessions, the center renders Runtime messages and an expandable event workstream, and the right rail exposes evidence, approvals, verification, and trace events.

From the repository root:

```bash
pnpm --filter @helm/desktop dev       # Vite + Electron with the local dev server
pnpm --filter @helm/desktop build     # Typecheck, bundle renderer and Electron main/preload
pnpm --filter @helm/desktop start     # Open the built renderer in Electron
```

The renderer receives only the narrow API exposed by the preload. Node integration is disabled and context isolation, sandboxing, and an IPC allowlist are enabled in the Electron window. Current IPC handlers expose runtime info, task submission, Run snapshot, pause/resume/cancel, approval resolution, and ordered Run events. Browser preview can show the workbench and theme controls, but does not provide Electron preload or IPC. The current slice still uses an in-memory ledger and MockProvider. See [desktop/runtime boundary](../../docs/design/desktop-runtime-boundary.md).

The workbench has Precision and Atelier style presets, light/dark themes, collapsible side rails, and a settings modal. These controls are presentation state; Run, approval, verification, and trace data are projected from the Runtime event ledger. Theme preferences are stored locally under `helm.theme` and `helm.style`.

For a real Kimi Code request, set `HELM_PROVIDER=kimi` before `pnpm --filter @helm/desktop start`. The Main process reads the Keychain item `com.helm.provider.kimi-code` for account `helm`; it never exposes the key to Renderer or Runtime events. Omit the variable to keep the deterministic MockProvider path.

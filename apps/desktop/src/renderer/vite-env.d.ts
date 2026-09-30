interface Window {
  helm?: {
    runtimeInfo: () => Promise<{ appVersion: string; platform: string; isPackaged: boolean }>
    requestApproval: (request: { action: string; reason?: string }) => Promise<unknown>
    subscribe: (channel: 'run:event', listener: (payload: unknown) => void) => () => void
  }
}

declare module '*.css' {
  const content: Record<string, string>
  export default content
}

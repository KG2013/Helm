import type { DomainEvent } from '@helm/runtime'

export type WebContentsLike = {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

type WindowRecord = {
  sender: WebContentsLike
  authorizedRuns: Set<string>
  lastSequenceByRun: Map<string, number>
  deliveredEvents: Map<string, string[]>
}

/** Main-process event fan-out with per-window Run authorization and deduplication. */
export class DesktopWindowRegistry {
  private readonly windows = new Map<WebContentsLike, WindowRecord>()

  register(sender: WebContentsLike): void {
    this.windows.set(sender, { sender, authorizedRuns: new Set(), lastSequenceByRun: new Map(), deliveredEvents: new Map() })
  }

  unregister(sender: WebContentsLike): void {
    this.windows.delete(sender)
  }

  has(sender: WebContentsLike): boolean {
    return this.windows.has(sender)
  }

  authorizeRun(sender: WebContentsLike, runId: string): void {
    const record = this.windows.get(sender)
    if (!record) throw new Error('IPC source rejected.')
    record.authorizedRuns.add(runId)
  }

  isAuthorized(sender: WebContentsLike, runId: string): boolean {
    return this.windows.get(sender)?.authorizedRuns.has(runId) ?? false
  }

  publish(event: DomainEvent, channel = 'helm:run-event'): void {
    if (!event.runId) return
    for (const record of this.windows.values()) {
      if (!record.authorizedRuns.has(event.runId) || record.sender.isDestroyed()) continue
      const delivered = record.deliveredEvents.get(event.runId) ?? []
      if (delivered.includes(event.id)) continue
      const lastSequence = record.lastSequenceByRun.get(event.runId) ?? 0
      if (event.sequence <= lastSequence) continue
      record.deliveredEvents.set(event.runId, [...delivered.slice(-127), event.id])
      record.lastSequenceByRun.set(event.runId, event.sequence)
      record.sender.send(channel, event)
    }
  }
}

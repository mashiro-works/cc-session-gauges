export type Window = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = {
  windows: Window[]
  contextPercent: number | null
  costUsd: number | null
  measuredAt: number
}
export type Turn = { seconds: number; tools: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Usage | null; turn: Turn | null; isHidden: boolean }
  }
}

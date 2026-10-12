// model-watch の状態（$.state に置くのでホットリロードを跨いで残る）
export type Bucket = { n: number; input: number; output: number; cacheRead: number; cacheWrite: number }
// main = メインループで答えたのがメインモデル / back = メインループなのに別モデル（裏） / sub = サブエージェント
export type Tally = { main: Record<string, Bucket>; back: Record<string, Bucket>; sub: Record<string, Bucket> }
export type SpawnRow = {
  agentId: string
  type: string
  requested: string | null
  resolved: string
  forced: string | null
  at: number
}
export type Stats = {
  turnId: string | null
  turn: Tally
  session: Tally
  spawns: SpawnRow[]
  forcedCount: number
  backSeen: string[]
}
export type Force = 'off' | 'opus' | 'sonnet'

declare module 'claude-code' {
  interface PluginState {
    'model-watch': {
      stats: Stats
      mainModel: string | null
      force: Force
      isHidden: boolean
      persist: string
    }
  }
}

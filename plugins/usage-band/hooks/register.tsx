import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Turn, Usage, Window } from '../types'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const turn = atom({ plugin: 'usage-band', key: 'turn' } as const, null)
const isHidden = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)

const BAR = 10
const WARN_RATE = 90
const WARN_CONTEXT = 85
const LONG_TURN_SECONDS = 120
const POLL_MS = 15000

// モジュール変数（再読み込みで初期化される）
const warned = new Set<string>()
let lastError = ''
let startedAt = 0
let tools = 0

function label(kind: string) {
  return kind === 'five_hour' ? '5時間' : kind === 'seven_day' ? '週次' : kind
}

function bar(percent: number) {
  const filled = Math.min(BAR, Math.max(0, Math.round((percent / 100) * BAR)))
  return '█'.repeat(filled) + '░'.repeat(BAR - filled)
}

function tone(percent: number) {
  return percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : 'green'
}

function resetText(iso?: string) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

// $ を受け取る関数はファイルの先頭で宣言する（エンジンが $ の行き先を追えるように）
async function refresh($: any) {
  try {
    const u = await $.session.usage()
    const next: Usage = {
      windows: (u.rateLimits ?? []).map(
        (w: any): Window => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt }),
      ),
      contextPercent: u.context?.percent ?? null,
      costUsd: u.cost?.usd ?? null,
      measuredAt: Date.now(),
    }
    lastError = ''
    await update($, usage, () => next)
    for (const w of next.windows) {
      const key = `${w.kind}:${Math.floor(w.percentUsed / 10)}`
      if (w.percentUsed >= WARN_RATE && !warned.has(key)) {
        warned.add(key)
        $.ui.toast(`${label(w.kind)}枠が ${w.percentUsed}% です（復帰 ${resetText(w.resetsAt) || '不明'}）`)
      }
    }
    if (next.contextPercent !== null && next.contextPercent >= WARN_CONTEXT && !warned.has('context')) {
      warned.add('context')
      $.ui.toast(`コンテキストが ${next.contextPercent}% です。/compact を検討してください`)
    }
  } catch (err) {
    lastError = String((err as any)?.message ?? err)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'usage-band', description: '使用量の帯の表示／非表示を切り替える' })
    } catch {}
    await refresh($)
    try {
      $.ui.log(`usage-band: 読み込みました${lastError ? `（計測の失敗: ${lastError}）` : ''}`)
    } catch {}
    try {
      $.clock.every(POLL_MS, () => refresh($))
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'usage-band' }, async $ => {
    const hidden = await read($, isHidden)
    await update($, isHidden, () => !hidden)
    return { text: hidden ? '使用量の帯を表示しました。' : '使用量の帯を隠しました。/usage-band でまた表示できます。' }
  })

  on('prompt.submit', async ($, e, next) => {
    startedAt = Date.now()
    tools = 0
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    tools += 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    const t: Turn = { seconds, tools }
    await update($, turn, () => t)
    if (startedAt > 0 && seconds > LONG_TURN_SECONDS) {
      $.ui.toast(`このターンは ${seconds} 秒かかりました（ツール ${tools} 回）`)
    }
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const u = await read($, usage)
    const t = await read($, turn)
    // 他の mod（model-watch 等）の帯を消さないよう、後続の描画結果を自分の下に積む
    const below = await next(e)

    if (u === null) {
      return (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>使用量: 計測待ち{lastError ? `（${lastError}）` : ''} </Text>
            <Button key="hide" label="隠す" onPress={() => update($, isHidden, () => true)} />
          </Box>
          {below}
        </Box>
      )
    }

    const windows = [...u.windows].sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))
    // ペインが横に開いていると帯が狭くなるので、狭いときは1項目1行にする
    const narrow = (e.props.bodyColumns ?? 120) < 110

    const windowText = (w: Window) => (
      <Text wrap="truncate-end">
        <Text dimColor>{label(w.kind)} </Text>
        <Text color={tone(w.percentUsed)}>{bar(w.percentUsed)}</Text>
        <Text bold> {w.percentUsed}%</Text>
        <Text dimColor>{w.resetsAt ? ` →${resetText(w.resetsAt)}` : ''}   </Text>
      </Text>
    )
    const contextText =
      u.contextPercent !== null ? (
        <Text wrap="truncate-end">
          <Text dimColor>文脈 </Text>
          <Text color={tone(u.contextPercent)}>{bar(u.contextPercent)}</Text>
          <Text bold> {u.contextPercent}%</Text>
          <Text dimColor>   </Text>
        </Text>
      ) : null
    const tail = (
      <Text wrap="truncate-end">
        {u.costUsd !== null && <Text dimColor>費用 ${u.costUsd.toFixed(2)}   </Text>}
        {t !== null && <Text dimColor>直近ターン {t.seconds}秒・ツール {t.tools}回 </Text>}
      </Text>
    )
    const hide = <Button key="hide" label="隠す" onPress={() => update($, isHidden, () => true)} />

    if (narrow) {
      return (
        <Box flexDirection="column">
          {windows.length === 0 && <Text dimColor>枠の読みはまだありません</Text>}
          {windows.map(w => <Box>{windowText(w)}</Box>)}
          {contextText && <Box>{contextText}</Box>}
          <Box>{tail}{hide}</Box>
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          {windows.length === 0 && <Text dimColor>枠の読みはまだありません  </Text>}
          {windows.map(w => windowText(w))}
        </Box>
        <Box>
          {contextText}
          {tail}
          {hide}
        </Box>
        {below}
      </Box>
    )
  })
}

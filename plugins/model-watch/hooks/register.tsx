import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Bucket, Force, SpawnRow, Stats, Tally } from '../types'

// ---------------------------------------------------------------------------
// model-watch
// どのモデルが答えたかを turn.step ごとに記録する。
//   main = メインループ（agentId なし）でメインモデルが答えた
//   back = メインループなのにメインモデル以外が答えた（裏の機能・フォールバックの可能性）
//   sub  = サブエージェント（agentId あり）
// 集計は $.state（ホットリロードを跨いで残る）、生記録は ~/.claude/model-watch/{sessionId}.jsonl。
// ---------------------------------------------------------------------------

const emptyTally = (): Tally => ({ main: {}, back: {}, sub: {} })
const emptyStats = (): Stats => ({
  turnId: null,
  turn: emptyTally(),
  session: emptyTally(),
  spawns: [],
  forcedCount: 0,
  backSeen: [],
})

const stats = atom({ plugin: 'model-watch', key: 'stats' } as const, emptyStats())
const mainModel = atom({ plugin: 'model-watch', key: 'mainModel' } as const, null)
const force = atom({ plugin: 'model-watch', key: 'force' } as const, 'off')
const isHidden = atom({ plugin: 'model-watch', key: 'isHidden' } as const, false)
const persist = atom({ plugin: 'model-watch', key: 'persist' } as const, '')

const FLUSH_MS = 30000
const FLUSH_LINES = 50
const MAX_PENDING = 5000
const MAX_SPAWNS = 200
const ROLL_CHARS = 3000000 // $.fs の 4 MiB 制限より手前で次のファイルへ
const NARROW_COLUMNS = 100
const FORCE_VALUES: readonly Force[] = ['off', 'opus', 'sonnet']

// モジュール変数（再読み込みで初期化される。集計の本体は $.state 側）
const pending: string[] = []
const agentTypes = new Map<string, string>()
let isFlushing = false
let cachedPath = ''
let part = 1
let lastPersist = ''

// ---- モデル名の整形（$ を使わない純関数） ----------------------------------

type Parsed = { family: string; ver: string }

function parseModel(id: string | null | undefined): Parsed {
  if (!id) return { family: '', ver: '' }
  let s = String(id).toLowerCase().trim()
  s = s.replace(/\[[^\]]*\]/g, '').replace(/^.*?claude-/, '').replace(/-v\d+(:\d+)?$/, '').replace(/-\d{8}$/, '')
  // 新しい形: opus-5-5 / sonnet-4-5 / fable-5
  let m = s.match(/^([a-z]+)-(\d+)(?:[-.](\d{1,2}))?(?![0-9])/)
  if (m && m[1] && m[2]) return { family: m[1], ver: m[3] !== undefined ? `${m[2]}.${m[3]}` : m[2] }
  // 古い形: 3-5-haiku
  m = s.match(/^(\d+)(?:[-.](\d+))?-([a-z]+)/)
  if (m && m[1] && m[3]) return { family: m[3], ver: m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1] }
  // 表示名: "Opus 5.5 (1M context)"
  m = s.match(/(opus|sonnet|haiku|fable)[\s-]*(\d+(?:\.\d+)?)/)
  if (m && m[1] && m[2]) return { family: m[1], ver: m[2] }
  // 別名だけ: "opus"
  m = s.match(/(opus|sonnet|haiku|fable)/)
  if (m && m[1]) return { family: m[1], ver: '' }
  return { family: '', ver: '' }
}

function short(id: string | null | undefined): string {
  const p = parseModel(id)
  if (!p.family) return String(id ?? '不明')
  const name = p.family.charAt(0).toUpperCase() + p.family.slice(1)
  return p.ver ? `${name} ${p.ver}` : name
}

function abbr(id: string): string {
  const p = parseModel(id)
  if (!p.family) return id.length > 12 ? `${id.slice(0, 11)}…` : id
  return `${p.family.charAt(0).toUpperCase()}${p.ver}`
}

function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = parseModel(a)
  const pb = parseModel(b)
  if (!pa.family || !pb.family) return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()
  if (pa.family !== pb.family) return false
  if (pa.ver && pb.ver && pa.ver !== pb.ver) return false
  return true
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function fmt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function addBucket(rec: Record<string, Bucket>, model: string, add: Bucket): Record<string, Bucket> {
  const old = rec[model] ?? { n: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  return {
    ...rec,
    [model]: {
      n: old.n + add.n,
      input: old.input + add.input,
      output: old.output + add.output,
      cacheRead: old.cacheRead + add.cacheRead,
      cacheWrite: old.cacheWrite + add.cacheWrite,
    },
  }
}

function addTo(t: Tally, kind: keyof Tally, model: string, add: Bucket): Tally {
  return { ...t, [kind]: addBucket(t[kind], model, add) }
}

// 同じ表示名（Opus 5.5 など）でまとめ、回数の多い順に並べる
function items(...recs: Record<string, Bucket>[]): { label: string; id: string; n: number }[] {
  const byLabel = new Map<string, { label: string; id: string; n: number }>()
  for (const rec of recs) {
    for (const [id, b] of Object.entries(rec)) {
      const label = short(id)
      const old = byLabel.get(label)
      byLabel.set(label, { label, id, n: (old?.n ?? 0) + b.n })
    }
  }
  return [...byLabel.values()].sort((x, y) => y.n - x.n)
}

function itemText(list: { label: string; id: string; n: number }[], isNarrow: boolean): string {
  if (list.length === 0) return '—'
  return list.map(i => `${isNarrow ? abbr(i.id) : i.label}×${i.n}`).join(' ')
}

function isForce(v: unknown): v is Force {
  return typeof v === 'string' && (FORCE_VALUES as readonly string[]).includes(v)
}

// ---- $ を受け取る関数（ファイルのトップレベルで宣言する） --------------------

async function setPersist($: any, text: string) {
  if (text === lastPersist) return
  lastPersist = text
  try {
    await update($, persist, () => text)
  } catch {}
}

async function logPath($: any): Promise<string> {
  if (cachedPath) return cachedPath
  const sid = String(await $.session.id()).replace(/[^A-Za-z0-9_-]/g, '_')
  let base = ''
  const root = String($.plugin.root)
  const m = root.match(/^(.*?[\\/]\.claude)(?:[\\/]|$)/)
  if (m && m[1]) base = m[1]
  if (!base) {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (home) base = `${home}${home.includes('\\') ? '\\' : '/'}.claude`
  }
  if (!base || !sid) throw new Error('保存先を決められません')
  const sep = base.includes('\\') ? '\\' : '/'
  cachedPath = `${base}${sep}model-watch${sep}${sid}.jsonl`
  return cachedPath
}

// $.fs には追記が無いので「読む→足す→書く」。同時実行はフラグで1本に絞る（漏れた分は次回に回る）
async function flush($: any) {
  if (isFlushing || pending.length === 0) return
  isFlushing = true
  const lines = pending.splice(0, pending.length)
  try {
    const path = await logPath($)
    let target = path
    let old = ''
    for (; part < 1000; part++) {
      target = part === 1 ? path : path.replace(/\.jsonl$/, `-${part}.jsonl`)
      old = (await $.fs.exists(target)) ? String(await $.fs.read(target)) : ''
      if (old.length < ROLL_CHARS) break
    }
    await $.fs.write(target, `${old}${lines.join('\n')}\n`)
    await setPersist($, `保存中: ${target}`)
  } catch (err) {
    pending.unshift(...lines)
    if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
    await setPersist($, `保存できません（メモリ集計のみで継続）: ${String((err as any)?.message ?? err)}`)
  } finally {
    isFlushing = false
  }
}

async function record($: any, e: any, r: any) {
  const u = r?.usage
  if (!u || typeof u.model !== 'string' || u.model === '' || u.model === '<synthetic>') return
  const model: string = u.model
  const isSub = typeof e.agentId === 'string' && e.agentId !== ''
  let ref = ''
  let isBack = false
  if (!isSub) {
    const main = await read($, mainModel)
    ref = main && parseModel(main).family ? main : String(e.model ?? '')
    isBack = !sameModel(model, ref)
  }
  const kind: keyof Tally = isSub ? 'sub' : isBack ? 'back' : 'main'
  const add: Bucket = {
    n: 1,
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  }
  let agentType: string | null = isSub ? (agentTypes.get(e.agentId) ?? null) : null
  let isFirstBack = false
  await update($, stats, s => {
    isFirstBack = isBack && !s.backSeen.includes(model)
    if (isSub && agentType === null) agentType = s.spawns.find(x => x.agentId === e.agentId)?.type ?? null
    // メインのステップが別ターンのものなら「今ターン」を切り替える（turn.start を取り逃した場合の保険）
    const isNewTurn = !isSub && s.turnId !== e.turnId
    const turn = isNewTurn ? emptyTally() : s.turn
    return {
      ...s,
      turnId: isNewTurn ? e.turnId : s.turnId,
      turn: addTo(turn, kind, model, add),
      session: addTo(s.session, kind, model, add),
      backSeen: isFirstBack ? [...s.backSeen, model] : s.backSeen,
    }
  })
  pending.push(
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'step',
      turnId: e.turnId ?? null,
      index: e.index ?? null,
      agentId: isSub ? e.agentId : null,
      agentType,
      requested: e.model ?? null,
      model,
      back: isBack,
      input_tokens: add.input,
      output_tokens: add.output,
      cache_read: add.cacheRead,
      cache_write: add.cacheWrite,
    }),
  )
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
  if (isFirstBack) {
    const text = `model-watch: メインループで ${short(model)} が答えました（メインは ${short(ref) || '不明'}）。裏の機能かフォールバックの可能性があります。/model-watch report で内訳`
    try {
      $.ui.toast(text, { timeoutMs: 8000 })
    } catch {}
    try {
      $.ui.log(text)
    } catch {}
  }
  if (pending.length >= FLUSH_LINES) await flush($)
}

async function noteSpawn($: any, e: any, r: any, forcedTo: string | null) {
  if (!r || typeof r !== 'object' || ('deny' in r && r.deny)) return
  const row: SpawnRow = {
    agentId: String(r.agentId ?? ''),
    type: String(e.subagentType ?? ''),
    requested: typeof e.model === 'string' ? e.model : null,
    resolved: String(r.model ?? ''),
    forced: forcedTo,
    at: Date.now(),
  }
  if (row.agentId) agentTypes.set(row.agentId, row.type)
  await update($, stats, s => ({
    ...s,
    spawns: [...s.spawns, row].slice(-MAX_SPAWNS),
    forcedCount: s.forcedCount + (forcedTo ? 1 : 0),
  }))
  pending.push(JSON.stringify({ ts: new Date().toISOString(), kind: 'spawn', ...row, parentModel: e.parentModel ?? null }))
}

async function report($: any) {
  await flush($)
  const s = await read($, stats)
  const f = await read($, force)
  const main = await read($, mainModel)
  const p = await read($, persist)
  const lines: string[] = []
  lines.push(`model-watch 累計（メインモデル: ${short(main)}／サブ固定: ${f}）`)
  lines.push('| 区分 | モデル | 回数 | 入力 | 出力 | キャッシュ読 | キャッシュ書 |')
  lines.push('|---|---|---:|---:|---:|---:|---:|')
  const kinds: [keyof Tally, string][] = [
    ['main', 'メイン'],
    ['back', '裏'],
    ['sub', 'サブ'],
  ]
  let rows = 0
  for (const [kind, label] of kinds) {
    const entries = Object.entries(s.session[kind]).sort((x, y) => y[1].n - x[1].n)
    for (const [id, b] of entries) {
      rows += 1
      lines.push(
        `| ${label} | ${short(id)} (${id}) | ${fmt(b.n)} | ${fmt(b.input)} | ${fmt(b.output)} | ${fmt(b.cacheRead)} | ${fmt(b.cacheWrite)} |`,
      )
    }
  }
  if (rows === 0) lines.push('| — | まだ記録がありません | 0 | 0 | 0 | 0 | 0 |')
  if (s.spawns.length > 0) {
    lines.push(`サブエージェント起動 ${s.spawns.length} 件（うち固定で差し替え ${s.forcedCount} 件）。直近15件:`)
    lines.push('| 種別 | 指定 | 実際 | 差し替え |')
    lines.push('|---|---|---|---|')
    for (const x of s.spawns.slice(-15)) {
      lines.push(`| ${x.type} | ${x.requested ?? '（指定なし）'} | ${short(x.resolved)} | ${x.forced ?? '—'} |`)
    }
  }
  lines.push(p || '保存: まだ書き込んでいません')
  for (const line of lines) {
    try {
      $.ui.log(line)
    } catch {}
  }
  return rows
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'model-watch',
        description: 'モデルの帯の表示切替／report で累計表／force でサブエージェントのモデル固定',
        argumentHint: '[report | force opus|sonnet|off | show | hide]',
      })
    } catch {}
    try {
      const m = await $.session.model()
      await update($, mainModel, () => (m ? String(m) : null))
    } catch {}
    try {
      $.clock.every(FLUSH_MS, () => flush($))
    } catch {}
    try {
      $.ui.log('model-watch: 読み込みました')
    } catch {}
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await flush($)
    } catch {}
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    try {
      const m = await $.session.model()
      await update($, mainModel, () => (m ? String(m) : null))
      await update($, stats, s => (s.turnId === e.turnId ? s : { ...s, turnId: e.turnId, turn: emptyTally() }))
    } catch {}
    return next(e)
  })

  // 1リクエストごと（メイン・サブとも）。応答を流し切った後に usage.model を読む
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      await record($, e, r)
    } catch {}
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      try {
        await flush($)
      } catch {}
    }
    return r
  })

  // 既定は観測のみ。/model-watch force opus|sonnet のときだけサブエージェントのモデルを差し替える
  on('agent.spawn', async ($, e, next) => {
    let f: Force = 'off'
    try {
      const v = await read($, force)
      if (isForce(v)) f = v
    } catch {}
    // fork は親を継承するので model が効かない。workflow の agent() は中身を書き換えられない
    const canForce = f !== 'off' && !e.fork && !e.workflow
    const changes = canForce && !(typeof e.model === 'string' && sameModel(e.model, f))
    const r = await next(changes ? { ...e, model: f } : e)
    try {
      await noteSpawn($, e, r, changes ? f : null)
    } catch {}
    return r
  })

  on('command.run', { command: 'model-watch' }, async ($, e) => {
    const args = String(e.args ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    const sub = (args[0] ?? '').toLowerCase()
    if (sub === '' || sub === 'toggle') {
      const hidden = await read($, isHidden)
      await update($, isHidden, () => !hidden)
      return { text: hidden ? 'モデルの帯を表示しました。' : 'モデルの帯を隠しました。/model-watch でまた表示できます。' }
    }
    if (sub === 'show' || sub === 'hide') {
      await update($, isHidden, () => sub === 'hide')
      return { text: sub === 'hide' ? 'モデルの帯を隠しました。' : 'モデルの帯を表示しました。' }
    }
    if (sub === 'force') {
      const v = (args[1] ?? '').toLowerCase()
      if (!isForce(v)) {
        const now = await read($, force)
        return { text: `使い方: /model-watch force opus | sonnet | off（現在: ${now}）` }
      }
      await update($, force, () => v)
      return {
        text:
          v === 'off'
            ? 'サブエージェントのモデル固定を解除しました（観測のみ）。'
            : `これ以降に起動するサブエージェントを ${v} に固定します（fork と workflow の agent() は対象外）。解除は /model-watch force off`,
      }
    }
    if (sub === 'report') {
      const rows = await report($)
      return { text: `model-watch: 累計表を出しました（${rows} 行）。` }
    }
    return { text: '使い方: /model-watch（表示切替） | report | force opus|sonnet|off | show | hide' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // 他の mod（usage-band 等）の帯を消さないよう、下の結果を必ず含めて返す
    const below = await next(e)
    if (e.props.hasSurvey || (await read($, isHidden))) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    const s = await read($, stats)
    const f = await read($, force)
    const isNarrow = (e.props.bodyColumns ?? 120) < NARROW_COLUMNS
    const total = s.session.main
    const hasAny =
      Object.keys(total).length + Object.keys(s.session.back).length + Object.keys(s.session.sub).length > 0

    const sep = <Text dimColor> ｜ </Text>
    const hide = <Button key="model-watch-hide" label="隠す" onPress={() => update($, isHidden, () => true)} />

    if (!hasAny) {
      return (
        <Box flexDirection="column">
          {below}
          <Box>
            <Text dimColor wrap="truncate-end">モデル: 記録待ち（次のリクエストから数えます） </Text>
            {hide}
          </Box>
        </Box>
      )
    }

    const turnMain = items(s.turn.main)
    const turnBack = items(s.turn.back)
    const turnSub = items(s.turn.sub)
    const all = items(s.session.main, s.session.back, s.session.sub)
    const back = items(s.session.back)

    return (
      <Box flexDirection="column">
        {below}
        <Box>
          <Text wrap="truncate-end">
            <Text dimColor>{isNarrow ? 'モデル 今 ' : 'モデル: 今ターン '}</Text>
            <Text>{itemText(turnMain, isNarrow)}</Text>
            {turnBack.length > 0 && <Text color="yellow" bold> 裏 {itemText(turnBack, isNarrow)}</Text>}
            {sep}
            <Text dimColor>サブ </Text>
            <Text color="cyan">{itemText(turnSub, isNarrow)}</Text>
            {sep}
            <Text dimColor>{isNarrow ? '計 ' : '累計 '}</Text>
            <Text>{itemText(all, isNarrow)}</Text>
            {back.length > 0 && sep}
            {back.length > 0 && (
              <Text color="yellow" bold>
                裏 {itemText(back, isNarrow)}
              </Text>
            )}
            {f !== 'off' && sep}
            {f !== 'off' && (
              <Text color="magenta">
                {isNarrow ? `固定 ${f}(${s.forcedCount})` : `サブ固定 ${f}（差し替え ${s.forcedCount} 件）`}
              </Text>
            )}
            <Text> </Text>
          </Text>
          {hide}
        </Box>
      </Box>
    )
  })
}

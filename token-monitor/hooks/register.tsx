import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'

import type { Bucket, Limit, Part, Quota, Rec, Spike, Stat, Thresholds, Totals, Turn, View } from '../types'

const PANE = 'token-monitor'
const TITLE = 'Token 監控'
const AUTO_COMPACT = 97
const KEEP_SAMPLES = 240
const KEEP_TURNS = 50
const KEEP_SESSIONS = 30
const KEEP_ERRORS = 20
const KEEP_SPIKES = 20
// A turn is a spike when it costs SPIKE_SIGMA deviations above this window's mean
// and SPIKE_RATIO times it, past SPIKE_MIN_TURNS turns; or when the context jumps.
const SPIKE_SIGMA = 3
const SPIKE_RATIO = 2
const SPIKE_MIN_TURNS = 5
const SPIKE_MIN_COST = 0.05
const SPIKE_CTX_JUMP = 30000
const MIN_QUOTA_TURNS = 10
const BIG_CONTEXT = 300000
const DEFAULT_THRESHOLDS: Thresholds = { warn: 60, danger: 85 }
const COMPACT_HINT =
  '保留目前的目標、已做的決定與理由、未完成事項、關鍵檔案路徑與參數數值。'

const PART_NAMES: Record<string, string> = {
  Messages: '對話訊息',
  'System tools': '系統工具',
  'MCP tools': 'MCP 工具',
  'System prompt': '系統提示',
  Skills: '技能',
  'Memory files': '記憶檔',
  'Custom agents': '自訂代理',
}

const emptyTotals = (): Totals => ({ turns: 0, output: 0, cached: 0, total: 0, cost: 0, byPart: {} })
const emptyStat = (): Stat => ({ n: 0, mean: 0, m2: 0 })

const EMPTY: View = {
  selfId: '',
  now: 0,
  recs: [],
  limits: [],
  thresholds: DEFAULT_THRESHOLDS,
  totals: emptyTotals(),
}
const view = atom({ plugin: 'token-monitor', key: 'view' } as const, EMPTY)
const bandCompact = atom({ plugin: 'token-monitor', key: 'bandCompact' } as const, true)
const paneOpen = atom({ plugin: 'token-monitor', key: 'paneOpen' } as const, false)

const emptyBucket = (): Bucket => ({ turns: 0, pp: 0 })
const emptyQuota = (): Quota => ({
  pendTurns: 0,
  pendCost: 0,
  pendCtx: 0,
  small: emptyBucket(),
  mid: emptyBucket(),
  big: emptyBucket(),
  pp: 0,
  cost: 0,
})

const normalize = (id: string, kept: Partial<Rec> | undefined): Rec => ({
  id,
  label: id.slice(0, 8),
  updatedAt: 0,
  window: 0,
  percent: 0,
  samples: [],
  compactions: [],
  turns: [],
  turnCount: 0,
  costTotal: 0,
  parts: [],
  mcp: [],
  errors: [],
  spikes: [],
  ...kept,
  quota: { ...emptyQuota(), ...kept?.quota },
  totals: { ...emptyTotals(), ...kept?.totals },
  costStat: { ...emptyStat(), ...kept?.costStat },
})

const wan = (n: number | undefined) =>
  n === undefined ? '-' : n >= 1000 ? `${(n / 10000).toFixed(1)}萬` : `${Math.round(n)}`

const usd = (n: number) => (n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`)

const spikeText = (sp: Spike) =>
  [
    sp.isCostSpike
      ? `突增：這一輪 ${usd(sp.cost)}（平均 ${usd(sp.mean)} 的 ${sp.mean > 0 ? (sp.cost / sp.mean).toFixed(1) : '-'} 倍）`
      : `突增：這一輪 ${usd(sp.cost)}`,
    sp.ctxJump >= SPIKE_CTX_JUMP ? `上下文 +${wan(sp.ctxJump)}` : '',
    sp.cause ? `主因 ${sp.cause} +${wan(sp.causeDelta)}` : '',
    sp.cacheRate !== undefined && sp.cacheRate < 0.5 ? `快取僅 ${Math.round(sp.cacheRate * 100)}%` : '',
  ]
    .filter(Boolean)
    .join('　')

const clock = (at: number) => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const ago = (now: number, at: number) => {
  const min = Math.max(0, Math.round((now - at) / 60000))
  if (min < 1) return '剛剛'
  if (min < 60) return `${min} 分前`
  if (min < 1440) return `${Math.round(min / 60)} 小時前`

  return `${Math.round(min / 1440)} 天前`
}

const until = (now: number, iso: string | undefined) => {
  if (!iso) return ''
  const min = Math.max(0, Math.round((Date.parse(iso) - now) / 60000))
  if (min < 60) return `${min} 分後重置`
  if (min < 1440) return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} 後重置`

  return `${Math.round(min / 1440)} 天後重置`
}

const charWidth = (c: string) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1)

const fit = (s: string, width: number) => {
  let out = ''
  let used = 0
  for (const c of s) {
    const w = charWidth(c)
    if (used + w > width) return out.slice(0, -1) + '…' + ' '.repeat(Math.max(0, width - used))
    out += c
    used += w
  }

  return out + ' '.repeat(width - used)
}

const level = (percent: number, t: Thresholds) =>
  percent >= t.danger ? 2 : percent >= t.warn ? 1 : 0

const paint = (percent: number, t: Thresholds) =>
  (['success', 'warning', 'error'] as const)[level(percent, t)]

// Solid cells are what is left, dotted cells what is used, so the solid part shrinks as usage grows.
const barParts = (usedPercent: number, width: number) => {
  const left = Math.max(0, Math.min(width, Math.round(((100 - usedPercent) / 100) * width)))

  return { left: '█'.repeat(left), used: '░'.repeat(width - left) }
}

const bar = (usedPercent: number, width: number) => {
  const parts = barParts(usedPercent, width)

  return parts.left + parts.used
}

const spark = (points: number[]) => {
  const ticks = '▁▂▃▄▅▆▇█'

  return points
    .map(p => ticks[Math.max(0, Math.min(7, Math.round((p / 100) * 7)))])
    .join('')
}

const bucketOf = (q: Quota, ctx: number) =>
  ctx < 200000 ? q.small : ctx < 500000 ? q.mid : q.big

const title = (r: Rec) => r.name ?? r.label

const resetAt = (iso: string | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())} 重置`
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5 小時限制',
  seven_day: '1 週限制',
  spend_limit: '花費上限',
}

let rec: Rec | undefined
let timer: Timer | undefined

async function load($: EngineInterface) {
  const id = await $.session.id()
  rec = normalize(id, (await $.store.get(`s:${id}`)) as Partial<Rec> | undefined)

  return rec
}

async function save($: EngineInterface, one: Rec) {
  await $.store.set(`s:${one.id}`, one)
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Keeps the latest problems on the session's record, so the pane can show them later.
async function noteError($: EngineInterface, where: string, error: unknown) {
  const message = messageOf(error)
  $.ui.log(`token-monitor: ${where}: ${message}`, { to: 'debug' })
  try {
    const one = rec ?? (await load($))
    one.errors = [...one.errors, { at: await $.clock.now(), where, message }].slice(-KEEP_ERRORS)
    await save($, one)
    await refresh($)
  } catch {
    // The store itself failed: the debug log line above is all that is left.
  }
}

async function thresholds($: EngineInterface) {
  return ((await $.store.get('thresholds')) as Thresholds | undefined) ?? DEFAULT_THRESHOLDS
}

async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  const keys = (await $.store.keys()).filter(k => k.startsWith('s:'))
  const recs: Rec[] = []
  for (const key of keys) {
    const one = (await $.store.get(key)) as Partial<Rec> | undefined
    if (one?.id) recs.push(normalize(one.id, one))
  }
  recs.sort((a, b) => b.updatedAt - a.updatedAt)
  for (const old of recs.slice(KEEP_SESSIONS)) {
    await $.store.delete(`s:${old.id}`)
  }
  const limits = ((await $.store.get('limits')) as Limit[] | undefined) ?? []
  const t = await thresholds($)
  const totals: Totals = { ...emptyTotals(), ...((await $.store.get('totals')) as Totals | undefined) }
  await update($, view, () => ({
    selfId: rec?.id ?? '',
    now,
    recs: recs.slice(0, KEEP_SESSIONS),
    limits,
    thresholds: t,
    totals,
  }))
}

async function autoLabel($: EngineInterface, one: Rec, cwd: string) {
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? one.id.slice(0, 8)
  const messages = await $.session.messages().catch(async error => {
    await noteError($, '讀取對話訊息', error)
    return []
  })
  const first = messages.find(
    m =>
      m.role === 'user' &&
      m.text.trim() !== '' &&
      !m.text.startsWith('This session is being continued') &&
      !m.text.trim().startsWith('<'),
  )
  const line = first?.text.trim().split('\n')[0] ?? ''
  one.label = line ? `${folder}·${line}` : `${folder}·${one.id.slice(0, 6)}`
}

async function readBreakdown($: EngineInterface, one: Rec) {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(async error => {
    await noteError($, '讀取上下文組成', error)
    return undefined
  })
  const breakdown = usage?.context.breakdown
  if (!breakdown) return
  one.parts = breakdown.categories
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .map(c => ({ name: PART_NAMES[c.name] ?? c.name, tokens: c.tokens }))
    .sort((a, b) => b.tokens - a.tokens)
  const servers = new Map<string, number>()
  for (const tool of breakdown.mcpTools) {
    if (!tool.isLoaded) continue
    servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
  }
  one.mcp = [...servers]
    .map(([name, tokens]): Part => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 4)
}

// Each turn resends the whole context, so a turn's input tokens and cost are split
// across the categories in the proportions its context had at that turn.
const addTurn = (t: Totals, turn: Turn, at: number) => {
  t.turns += 1
  t.output += turn.output ?? 0
  t.cached += turn.cached ?? 0
  t.total += turn.tokens ?? 0
  t.cost += turn.cost
  t.since ??= at
  const parts = turn.parts ?? []
  const sum = parts.reduce((s, p) => s + p.tokens, 0)
  if (sum <= 0) return
  t.first ??= parts
  const input = Math.max(0, (turn.tokens ?? 0) - (turn.output ?? 0))
  for (const p of parts) {
    const one = (t.byPart[p.name] ??= { tokens: 0, cost: 0 })
    one.tokens += (input * p.tokens) / sum
    one.cost += (turn.cost * p.tokens) / sum
  }
}

const addStat = (st: Stat, x: number) => {
  st.n += 1
  const d = x - st.mean
  st.mean += d / st.n
  st.m2 += d * (x - st.mean)
}

const sigma = (st: Stat) => (st.n > 1 ? Math.sqrt(st.m2 / (st.n - 1)) : 0)

// Judged against the turns before this one, so a spike does not hide itself.
const spikeOf = (one: Rec, turn: Turn, prev: Turn | undefined): Spike | undefined => {
  const st = one.costStat
  const isCostSpike =
    st.n >= SPIKE_MIN_TURNS &&
    turn.cost >= SPIKE_MIN_COST &&
    turn.cost > st.mean + SPIKE_SIGMA * sigma(st) &&
    turn.cost > st.mean * SPIKE_RATIO
  const ctxJump = prev ? turn.ctx - prev.ctx : 0
  if (!isCostSpike && ctxJump < SPIKE_CTX_JUMP) return undefined
  const before = prev?.parts ?? []
  const cause = (turn.parts ?? [])
    .map(p => ({ name: p.name, delta: p.tokens - (before.find(b => b.name === p.name)?.tokens ?? 0) }))
    .sort((a, b) => b.delta - a.delta)[0]

  return {
    at: turn.at,
    cost: turn.cost,
    mean: st.mean,
    ctxJump,
    isCostSpike,
    cause: cause && cause.delta > 0 ? cause.name : undefined,
    causeDelta: cause && cause.delta > 0 ? cause.delta : undefined,
    cacheRate: turn.tokens ? (turn.cached ?? 0) / turn.tokens : undefined,
  }
}

async function countTurn($: EngineInterface, one: Rec, turn: ModelUsage | undefined) {
  await readBreakdown($, one)
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const ctx = usage.context.tokens ?? one.tokens ?? 0
  const total = usage.cost?.usd ?? one.costTotal
  const spent = Math.max(0, total - (one.lastCost ?? total))
  one.lastCost = total
  one.costTotal = total
  one.turnCount += 1
  const tokens = turn
    ? turn.input_tokens +
      turn.cache_read_input_tokens +
      turn.cache_creation_input_tokens +
      turn.output_tokens
    : undefined
  const record: Turn = {
    at: now,
    ctx,
    cost: spent,
    tokens,
    cached: turn?.cache_read_input_tokens,
    output: turn?.output_tokens,
    parts: one.parts,
  }
  const spike = spikeOf(one, record, one.turns.at(-1))
  if (spike) {
    one.spikes = [...one.spikes, spike].slice(-KEEP_SPIKES)
    $.ui.toast(spikeText(spike))
  }
  addStat(one.costStat, spent)
  addTurn(one.totals, record, now)
  const all: Totals = { ...emptyTotals(), ...((await $.store.get('totals')) as Totals | undefined) }
  addTurn(all, record, now)
  await $.store.set('totals', all)
  one.turns = [...one.turns, record].slice(-KEEP_TURNS)

  const q = one.quota
  q.pendTurns += 1
  q.pendCost += spent
  q.pendCtx += ctx
  const five = usage.rateLimits.find(l => l.kind === 'five_hour')
  if (five) {
    if (q.lastPct === undefined || five.percentUsed < q.lastPct) {
      q.pendTurns = 0
      q.pendCost = 0
      q.pendCtx = 0
    } else if (five.percentUsed > q.lastPct) {
      const delta = five.percentUsed - q.lastPct
      const bucket = bucketOf(q, q.pendCtx / q.pendTurns)
      bucket.turns += q.pendTurns
      bucket.pp += delta
      q.pp += delta
      q.cost += q.pendCost
      q.pendTurns = 0
      q.pendCost = 0
      q.pendCtx = 0
    }
    q.lastPct = five.percentUsed
  }
  one.updatedAt = now
  await save($, one)
}

// Compacting directly can be refused (a turn running, or a host that does not
// take it from a plugin); /compact queued as a command runs once the session is idle.
async function compactNow($: EngineInterface, instructions: string) {
  try {
    const done = await $.session.compact({ instructions })

    return done.skip ? `沒有壓縮：${done.skip}` : '已壓縮'
  } catch (error) {
    const reason = messageOf(error)
    await noteError($, '直接壓縮被拒', error)
    void $.command.run({ command: 'compact', args: instructions }).catch(async again => {
      const why = messageOf(again)
      await noteError($, '改用 /compact 也失敗', again)
      $.ui.toast(`無法壓縮：${reason}（改用 /compact 也失敗：${why}）`)
    })

    return '已排入 /compact，對話空閒時自動壓縮'
  }
}

async function setBandCompact($: EngineInterface, value: boolean) {
  await update($, bandCompact, () => value)
  await $.store.set('bandCompact', value)
}

async function isPaneUp($: EngineInterface) {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

async function togglePane($: EngineInterface) {
  const isUp = await isPaneUp($)
  if (isUp) await $.ui.close({ id: PANE })
  else await $.ui.open({ id: PANE, title: TITLE })
  await update($, paneOpen, () => !isUp)

  return !isUp
}

type Spend = { name: string; tokens: number; cost: number; share: number }

const summarize = (t: Totals, last: Part[]) => {
  const input = Object.values(t.byPart).reduce((s, x) => s + x.tokens, 0)
  const spends: Spend[] = Object.entries(t.byPart)
    .map(([name, x]) => ({ name, ...x, share: input > 0 ? x.tokens / input : 0 }))
    .sort((a, b) => b.tokens - a.tokens)
  const first = t.first ?? []
  const growth = last
    .map(p => ({ name: p.name, delta: p.tokens - (first.find(f => f.name === p.name)?.tokens ?? 0) }))
    .sort((a, b) => b.delta - a.delta)[0]

  return { spends, growth }
}

const windowTotals = (turns: Turn[]) => {
  const t = emptyTotals()
  for (const turn of turns) addTurn(t, turn, turn.at)

  return t
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const wasCompact = (await $.store.get('bandCompact')) !== false
    await update($, bandCompact, () => wasCompact)
    const isUp = await isPaneUp($)
    await update($, paneOpen, () => isUp)
    const one = await load($)
    if (!one.name) await autoLabel($, one, e.cwd)
    one.endedAt = undefined
    one.updatedAt = await $.clock.now()
    await save($, one)
    await $.command.register({
      name: 'tokens',
      description:
        'Token 監控：/tokens 開關詳細面板、/tokens mini 或 full 切換用量列、/tokens name 名稱、/tokens compact 指示、/tokens warn 60 85',
    })
    timer?.cancel?.()
    timer = $.clock.every(20000, () => void refresh($))
    await refresh($)

    return started
  })

  on('session.end', async ($, e, next) => {
    if (rec) {
      rec.endedAt = await $.clock.now()
      await save($, rec)
    }

    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    const one = rec ?? (await load($))

    if (verb === 'name') {
      one.name = arg || undefined
      await save($, one)
      await refresh($)

      return { text: arg ? `這個視窗改名為「${arg}」` : '已改回自動名稱' }
    }
    if (verb === 'compact') {
      return { text: await compactNow($, arg || COMPACT_HINT) }
    }
    if (verb === 'mini' || verb === 'full') {
      await setBandCompact($, verb === 'mini')

      return { text: verb === 'mini' ? '用量列已縮成一行' : '用量列已展開' }
    }
    if (verb === 'warn') {
      const [warn, danger] = rest.map(Number)
      if (!(warn > 0 && danger > warn && danger <= 100)) {
        return { text: '用法：/tokens warn 60 85（提醒門檻、警告門檻）' }
      }
      await $.store.set('thresholds', { warn, danger })
      await refresh($)

      return { text: `門檻改為 ${warn}% / ${danger}%` }
    }
    const isUp = await togglePane($)

    return { text: isUp ? 'Token 詳細面板已開啟' : 'Token 詳細面板已關閉' }
  })

  on('ui.close', async ($, e, next) => {
    const ran = await next(e)
    if (e.id === PANE) await update($, paneOpen, () => false)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined) {
      try {
        await countTurn($, rec ?? (await load($)), e.usage)
        await refresh($)
      } catch (error) {
        await noteError($, '記錄這一輪', error)
      }
    }

    return ran
  })

  on('session.measure', async ($, e, next) => {
    const ran = await next(e)
    const one = rec ?? (await load($))
    const percent = e.context.percent ?? one.percent
    one.tokens = e.context.tokens ?? one.tokens
    one.window = e.context.window
    one.percent = percent
    one.updatedAt = await $.clock.now()
    if (e.context.tokens !== undefined) {
      one.samples = [...one.samples, [one.updatedAt, percent] as [number, number]].slice(
        -KEEP_SAMPLES,
      )
    }
    if (e.cost) one.costTotal = e.cost.usd
    try {
      if (e.changed.includes('context')) await readBreakdown($, one)
      await save($, one)
      if (e.rateLimits.length > 0) await $.store.set('limits', e.rateLimits)
      await refresh($)
    } catch (error) {
      await noteError($, '更新用量', error)
    }

    return ran
  })

  on('session.compact', async ($, e, next) => {
    const costBefore = (await $.session.usage()).cost?.usd
    const ran = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && ran.skip === undefined) {
      const one = rec ?? (await load($))
      const costAfter = (await $.session.usage()).cost?.usd
      one.compactions = [
        ...one.compactions,
        {
          at: await $.clock.now(),
          trigger: e.trigger,
          before: ran.tokensBefore,
          after: ran.tokensAfter,
          cost:
            costBefore !== undefined && costAfter !== undefined
              ? Math.max(0, costAfter - costBefore)
              : undefined,
        },
      ]
      one.lastCost = costAfter ?? one.lastCost
      await save($, one)
      await refresh($)
    }

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await read($, view)
    const me = v.recs.find(r => r.id === v.selfId)
    if (!me) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const t = v.thresholds
    const meter = (percent: number, width: number) => {
      const parts = barParts(percent, width)

      return (
        <Box flexDirection="row" flexShrink={0}>
          <Text color={paint(percent, t)}>{parts.left}</Text>
          <Text dimColor>{parts.used}</Text>
        </Box>
      )
    }
    const isCompact = await read($, bandCompact)
    const isPaneUp = await read($, paneOpen)
    const five = v.limits.find(l => l.kind === 'five_hour')
    const week = v.limits.find(l => l.kind === 'seven_day')
    const lastTurn = me.turns.at(-1)
    const hasContext = me.tokens !== undefined

    const buttons = (
      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Button
          key="pane"
          dimColor={!isPaneUp}
          onPress={() => {
            void togglePane($)
          }}
        >
          {isPaneUp ? '詳細 ◂' : '詳細 ▸'}
        </Button>
        <Button
          key="band"
          dimColor
          onPress={() => {
            void setBandCompact($, !isCompact)
          }}
        >
          {isCompact ? '展開 ▴' : '收合 ▾'}
        </Button>
      </Box>
    )

    if (isCompact) {
      const parts = [
        lastTurn ? `本輪 ${usd(lastTurn.cost)}` : undefined,
        five ? `5h ${Math.round(five.percentUsed)}%` : undefined,
        week ? `週 ${Math.round(week.percentUsed)}%` : undefined,
      ]
        .filter(Boolean)
        .join(' · ')

      return (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" width="100%">
          <Box flexDirection="row" flexShrink={1}>
            {hasContext && meter(me.percent, 8)}
            <Text color={hasContext ? paint(me.percent, t) : undefined} tabular>
              {hasContext ? ` 已用 ${Math.round(me.percent)}%` : '上下文 —'}
            </Text>
            <Text dimColor tabular wrap="truncate-end">
              {parts ? ` · ${parts}` : ''}
            </Text>
          </Box>
          {buttons}
        </Box>
      )
    }

    const row = (key: string, label: string, percent: number | undefined, detail: string, note?: string) => (
      <Box key={key} flexDirection="row" gap={1}>
        <Box width={12} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        {percent !== undefined && meter(percent, 16)}
        <Text bold tabular>
          {detail}
        </Text>
        {note && (
          <Text dimColor wrap="truncate-end">
            {note}
          </Text>
        )}
      </Box>
    )
    const left =
      me.window > 0 ? Math.max(0, (me.window * AUTO_COMPACT) / 100 - (me.tokens ?? 0)) : 0
    const limits = [
      { kind: 'five_hour', limit: five },
      { kind: 'seven_day', limit: week },
      ...v.limits
        .filter(l => l.kind !== 'five_hour' && l.kind !== 'seven_day')
        .map(l => ({ kind: l.kind, limit: l as Limit | undefined })),
    ]

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" width="100%">
          <Text bold>用量狀態</Text>
          {buttons}
        </Box>
        {row(
          'context',
          '上下文',
          hasContext ? me.percent : undefined,
          hasContext ? `已用 ${Math.round(me.percent)}%` : '尚無資料',
          hasContext ? `(${wan(me.tokens)} / ${wan(me.window)}，距自動壓縮 ${wan(left)})` : undefined,
        )}
        {lastTurn &&
          row(
            'turn',
            '本輪',
            undefined,
            usd(lastTurn.cost),
            lastTurn.tokens !== undefined ? `(處理 ${wan(lastTurn.tokens)} token)` : undefined,
          )}
        {limits.map(({ kind, limit }) =>
          row(
            kind,
            LIMIT_LABELS[kind] ?? kind,
            limit?.percentUsed,
            limit ? `已用 ${Math.round(limit.percentUsed)}%` : '尚無資料',
            limit?.resetsAt ? `(${resetAt(limit.resetsAt)})` : undefined,
          ),
        )}
        {row('cost', '本階段花費', undefined, usd(me.costTotal))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const meter = (percent: number, width: number) => {
      const parts = barParts(percent, width)

      return (
        <Box flexDirection="row" flexShrink={0}>
          <Text color={paint(percent, v.thresholds)}>{parts.left}</Text>
          <Text dimColor>{parts.used}</Text>
        </Box>
      )
    }
    const t = v.thresholds
    const me = v.recs.find(r => r.id === v.selfId)
    const cols = e.props.bodyColumns ?? 40
    const width = Math.max(10, Math.min(28, cols - 8))

    if (!me) {
      return <Text dimColor>等待第一次用量資料…</Text>
    }

    const left =
      me.window > 0 ? Math.max(0, (me.window * AUTO_COMPACT) / 100 - (me.tokens ?? 0)) : 0
    const lastTurn = me.turns.at(-1)
    const recent = me.turns.slice(-10)
    const avg = recent.length > 0 ? recent.reduce((s, x) => s + x.cost, 0) / recent.length : 0
    const used = me.parts.reduce((s, p) => s + p.tokens, 0)
    const messages = me.parts.find(p => p.name === '對話訊息')?.tokens ?? 0
    const shown = me.parts.slice(0, 5)
    const compactions = me.compactions.slice(-3).reverse()
    const tracked = me.turns.filter(turn => (turn.parts?.length ?? 0) > 0)
    const recentTotals = windowTotals(tracked)
    const mine = summarize(me.totals, me.parts)
    const recentShare = new Map(summarize(recentTotals, me.parts).spends.map(sp => [sp.name, sp.share]))
    const everywhere = summarize(v.totals, me.parts)
    const pct = (x: number) => `${Math.round(x * 100)}%`
    const five = v.limits.find(l => l.kind === 'five_hour')
    const week = v.limits.find(l => l.kind === 'seven_day')

    const q = me.quota
    const rows: [string, Bucket][] = [
      ['20萬以下', q.small],
      ['20–50萬', q.mid],
      ['50萬以上', q.big],
    ]
    const sampled = q.small.turns + q.mid.turns + q.big.turns

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold wrap="truncate-end">本視窗　{title(me)}</Text>
          <Box flexDirection="row">
            {meter(me.percent, width)}
            <Text color={paint(me.percent, t)} tabular>{` 已用 ${Math.round(me.percent)}%`}</Text>
          </Box>
          <Text dimColor tabular>
            {wan(me.tokens)} / {wan(me.window)}　距自動壓縮 {wan(left)}
          </Text>
          <Text dimColor>{spark(me.samples.slice(-width).map(s => s[1]))}</Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>實際消耗</Text>
          {lastTurn ? (
            <Box flexDirection="column">
              <Text dimColor tabular>
                這一輪　　　{usd(lastTurn.cost)}　上下文 {wan(lastTurn.ctx)}
              </Text>
              {lastTurn.tokens !== undefined && (
                <Text dimColor tabular>
                  這一輪處理　{wan(lastTurn.tokens)} token
                  {lastTurn.cached !== undefined && lastTurn.tokens > 0
                    ? `　快取 ${Math.round((lastTurn.cached / lastTurn.tokens) * 100)}%`
                    : ''}
                </Text>
              )}
              <Text dimColor tabular>
                本視窗累計　{usd(me.costTotal)}　（記錄 {me.turnCount} 輪）
              </Text>
              <Text dimColor tabular>
                近 {recent.length} 輪平均 {usd(avg)} / 輪
              </Text>
            </Box>
          ) : (
            <Text dimColor>完成一輪對話後開始記錄</Text>
          )}
          {(me.tokens ?? 0) >= BIG_CONTEXT && (
            <Text color="yellow">上下文大，每句話都要重送 {wan(me.tokens)}</Text>
          )}
          <Text dimColor>金額為 API 等價費用，Pro 方案不另收</Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>額度對照（5 小時額度）</Text>
          {sampled < MIN_QUOTA_TURNS ? (
            <Text dimColor>
              資料累積中（{sampled}/{MIN_QUOTA_TURNS} 輪）
            </Text>
          ) : (
            <Box flexDirection="column">
              {rows.map(([label, b]) => (
                <Text dimColor tabular>
                  {`上下文 ${fit(label, 9)}${b.turns > 0 ? `每輪約 ${(b.pp / b.turns).toFixed(2)}%　(${b.turns} 輪)` : '尚無樣本'}`}
                </Text>
              ))}
              {q.cost > 0 && (
                <Text dimColor tabular>
                  每 $1 API 等價 ≈ 額度 {(q.pp / q.cost).toFixed(1)}%
                </Text>
              )}
            </Box>
          )}
          <Text dimColor>額度全帳號共用，其他視窗同時在跑會偏高</Text>
        </Box>

        {shown.length > 0 && (
          <Box flexDirection="column">
            <Text bold>上下文組成</Text>
            {shown.map(p => (
              <Text dimColor tabular>
                {fit(p.name, 10)}{wan(p.tokens).padStart(7)}　{used > 0 ? Math.round((p.tokens / used) * 100) : 0}%
              </Text>
            ))}
            {me.mcp.length > 0 && (
              <Text dimColor wrap="truncate-end">
                MCP：{me.mcp.map(m => `${m.name} ${wan(m.tokens)}`).join(' · ')}
              </Text>
            )}
            <Text dimColor>固定開銷 {wan(used - messages)}，每輪都要付</Text>
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>Token 花在哪裡</Text>
          {me.totals.turns === 0 || mine.spends.length === 0 ? (
            <Text dimColor>下一輪對話後開始分類記錄</Text>
          ) : (
            <Box flexDirection="column">
              <Text dimColor tabular>
                {fit('', 10)}{`本視窗累計 ${me.totals.turns} 輪`.padEnd(14)}近 {tracked.length} 輪
              </Text>
              {mine.spends.slice(0, 6).map(sp => (
                <Text dimColor tabular>
                  {fit(sp.name, 10)}
                  {`${wan(sp.tokens).padStart(7)} ${pct(sp.share).padStart(4)} ≈${usd(sp.cost)}`.padEnd(22)}
                  {recentShare.has(sp.name) ? pct(recentShare.get(sp.name) ?? 0).padStart(4) : '   -'}
                </Text>
              ))}
              <Text dimColor tabular>
                {fit('模型輸出', 10)}{wan(me.totals.output).padStart(7)}
              </Text>
              {me.totals.total > 0 && (
                <Text dimColor tabular>
                  快取命中 累計 {pct(me.totals.cached / me.totals.total)}
                  {recentTotals.total > 0 ? `　近期 ${pct(recentTotals.cached / recentTotals.total)}` : ''}
                </Text>
              )}
              {mine.growth && mine.growth.delta > 0 && me.totals.turns > 1 && (
                <Text dimColor>
                  開始至今成長最多：{mine.growth.name} +{wan(mine.growth.delta)}
                </Text>
              )}
            </Box>
          )}
          {v.totals.turns > 0 && everywhere.spends.length > 0 && (
            <Text dimColor wrap="truncate-end">
              所有視窗 {v.totals.turns} 輪 {usd(v.totals.cost)}：
              {everywhere.spends
                .slice(0, 3)
                .map(sp => `${sp.name} ${pct(sp.share)}`)
                .join(' · ')}
            </Text>
          )}
          <Text dimColor>依每輪當下的上下文比例分攤，金額為估計值</Text>
        </Box>

        <Box flexDirection="column">
          <Text bold color={me.spikes.length > 0 ? 'warning' : undefined}>
            突增消耗　{me.spikes.length} 次
          </Text>
          {me.spikes.length === 0 ? (
            <Text dimColor>
              {me.costStat.n < SPIKE_MIN_TURNS
                ? `建立基準中（${me.costStat.n}/${SPIKE_MIN_TURNS} 輪）`
                : `平均每輪 ${usd(me.costStat.mean)}，尚未偵測到突增`}
            </Text>
          ) : (
            me.spikes
              .slice(-5)
              .reverse()
              .map(sp => (
                <Text dimColor wrap="truncate-end">
                  {clock(sp.at)}　{spikeText(sp).replace(/^突增：/, '')}
                </Text>
              ))
          )}
          <Text dimColor>
            條件：花費超過平均 {SPIKE_RATIO} 倍且高於 {SPIKE_SIGMA}σ，或上下文一輪增加 {wan(SPIKE_CTX_JUMP)}
          </Text>
        </Box>

        {me.errors.length > 0 && (
          <Box flexDirection="column">
            <Text bold color="warning">最近問題　{me.errors.length} 筆</Text>
            {me.errors
              .slice(-5)
              .reverse()
              .map(p => (
                <Text dimColor wrap="truncate-end">
                  {clock(p.at)}　{p.where}：{p.message}
                </Text>
              ))}
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>壓縮　{me.compactions.length} 次</Text>
          {compactions.length === 0 && <Text dimColor>外掛啟用後尚無紀錄</Text>}
          {compactions.map(c => {
            const saved =
              c.before && c.after !== undefined && c.before > 0
                ? Math.round((1 - c.after / c.before) * 100)
                : undefined
            const payback =
              c.before && c.after !== undefined && c.before > c.after
                ? Math.ceil((c.before + c.after) / (c.before - c.after))
                : undefined

            return (
              <Text dimColor tabular>
                {clock(c.at)}　{wan(c.before)} → {wan(c.after)}　{c.trigger}
                {saved !== undefined ? `　省 ${saved}%` : ''}
                {payback !== undefined ? `　約 ${payback} 輪回本` : ''}
                {c.cost !== undefined ? `　花 ${usd(c.cost)}` : ''}
              </Text>
            )
          })}
          <Button
            key="compact"
            dimColor={level(me.percent, t) === 0}
            onPress={() => {
              void compactNow($, COMPACT_HINT).then(text => $.ui.toast(text))
            }}
          >
            現在手動壓縮
          </Button>
          <Text dimColor>自訂保留內容：/tokens compact 你的指示</Text>
        </Box>

        {(five || week) && (
          <Box flexDirection="column">
            <Text bold>方案額度</Text>
            {five && (
              <Box flexDirection="row">
                <Text dimColor>{'5 小時　'}</Text>
                {meter(five.percentUsed, 12)}
                <Text color={paint(five.percentUsed, t)} tabular>
                  {` 已用 ${Math.round(five.percentUsed)}%　${until(v.now, five.resetsAt)}`}
                </Text>
              </Box>
            )}
            {week && (
              <Box flexDirection="row">
                <Text dimColor>{'每週　　'}</Text>
                {meter(week.percentUsed, 12)}
                <Text color={paint(week.percentUsed, t)} tabular>
                  {` 已用 ${Math.round(week.percentUsed)}%　${until(v.now, week.resetsAt)}`}
                </Text>
              </Box>
            )}
          </Box>
        )}

        <Box flexDirection="column">
          <Text bold>所有視窗</Text>
          {v.recs.map(r => {
            const isMe = r.id === v.selfId
            const isEnded = r.endedAt !== undefined

            return (
              <Text
                color={isMe || isEnded ? undefined : paint(r.percent, t)}
                dimColor={isEnded}
                tabular
                wrap="truncate-end"
              >
                {`${isMe ? '▸' : ' '} ${fit(title(r), Math.max(8, cols - 30))} ${isEnded ? '──────' : bar(r.percent, 6)} ${
                  isEnded ? '  — ' : `${String(Math.round(r.percent)).padStart(3)}%`
                }　壓縮${r.compactions.length}　${isEnded ? '已結束' : ago(v.now, r.updatedAt)}`}
              </Text>
            )
          })}
          <Text dimColor>改名：/tokens name 名稱</Text>
        </Box>
      </Box>
    )
  })
}

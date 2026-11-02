export type Sample = [at: number, percent: number]

export type Compaction = {
  at: number
  trigger: string
  before?: number
  after?: number
  cost?: number
}

export type Turn = {
  at: number
  ctx: number
  cost: number
  tokens?: number
  cached?: number
  output?: number
  parts?: Part[]
}

export type Tally = { tokens: number; cost: number }

// Running sums: adding a turn needs only these, never the turns before it.
export type Totals = {
  turns: number
  output: number
  cached: number
  total: number
  cost: number
  byPart: Record<string, Tally>
  first?: Part[]
  since?: number
}

// Welford's running mean and variance of one figure per turn.
export type Stat = { n: number; mean: number; m2: number }

export type Spike = {
  at: number
  cost: number
  mean: number
  ctxJump: number
  isCostSpike: boolean
  cause?: string
  causeDelta?: number
  cacheRate?: number
}

export type Problem = { at: number; where: string; message: string }

export type Bucket = { turns: number; pp: number }

export type Quota = {
  lastPct?: number
  pendTurns: number
  pendCost: number
  pendCtx: number
  small: Bucket
  mid: Bucket
  big: Bucket
  pp: number
  cost: number
}

export type Part = { name: string; tokens: number }

export type Rec = {
  id: string
  label: string
  name?: string
  updatedAt: number
  endedAt?: number
  tokens?: number
  window: number
  percent: number
  samples: Sample[]
  compactions: Compaction[]
  turns: Turn[]
  turnCount: number
  costTotal: number
  lastCost?: number
  parts: Part[]
  mcp: Part[]
  quota: Quota
  errors: Problem[]
  totals: Totals
  costStat: Stat
  spikes: Spike[]
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Thresholds = { warn: number; danger: number }

export type View = {
  selfId: string
  now: number
  recs: Rec[]
  limits: Limit[]
  thresholds: Thresholds
  totals: Totals
}

declare module 'claude-code' {
  interface PluginState {
    'token-monitor': { view: View; bandCompact: boolean; paneOpen: boolean }
  }
}

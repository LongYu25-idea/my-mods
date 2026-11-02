import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'token-monitor',
  component: 'Pane',
  requestId: 'token-monitor',
  props: {
    title: 'Token 監控',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const engine = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
  const store = new Map<string, unknown>()
  let cost = 1
  let five = 10
  let now = 1_700_000_000_000
  const context = { tokens: 473110, window: 1000000, percent: 47 }

  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('clock.now', () => ({ value: (now += 1000) }))
  on('clock.every', () => ({ value: {} }))
  on('session.id', () => ({ value: 'abcdef123456' }))
  on('session.messages', () => ({
    value: [{ role: 'user', text: 'Blender 連接實驗\n細節', toolUses: [] }],
  }))
  on('session.usage', (_, e) => ({
    value: {
      startedAt: 0,
      context: {
        ...context,
        breakdown: e?.breakdown
          ? {
              categories: [
                { name: 'Messages', tokens: 392285, color: '', isDeferred: false, kind: 'used' },
                { name: 'System tools', tokens: 43760, color: '', isDeferred: false, kind: 'used' },
                { name: 'Free space', tokens: 500000, color: '', isDeferred: false, kind: 'free' },
              ],
              mcpTools: [
                { name: 'mcp__gmail__send', serverName: 'gmail', tokens: 8000, isLoaded: true },
                { name: 'mcp__cal__list', serverName: 'calendar', tokens: 6000, isLoaded: true },
              ],
            }
          : undefined,
      },
      rateLimits: [{ kind: 'five_hour', percentUsed: five }],
      cost: { usd: cost },
    },
  }))
  on('command.register', () => ({ value: { command: 'tokens' } }))
  let isPaneUp = false
  on('ui.open', () => ((isPaneUp = true), { value: { isPlaced: true } }))
  on('ui.close', () => ((isPaneUp = false), { value: undefined }))
  on('ui.panes', () => ({
    value: isPaneUp
      ? [{ id: 'token-monitor', title: 'Token 監控', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => (toasts.push(String(e.text)), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: 'ok' }))

  return {
    toasts,
    isPaneUp: () => isPaneUp,
    spend: (usd: number, pp: number) => {
      cost += usd
      five += pp
    },
  }
}

test('the pane shows this window, its spend and the quota table', async ($, on) => {
  const fake = engine(on)
  await $.session.start({ cwd: 'C:\\work\\raiden', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 473110, window: 1000000, percent: 47 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 10 }],
    changed: ['context', 'rateLimits'],
  })
  for (let i = 0; i < 12; i++) {
    fake.spend(0.5, i % 2 === 0 ? 0 : 1)
    await $.turn.complete({
      reason: 'answer',
      answer: 'ok',
      durationMs: 1000,
      isAborted: false,
      turnId: `t${i}`,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 2000,
        output_tokens: 1000,
        cache_read_input_tokens: 900000,
        cache_creation_input_tokens: 97000,
      },
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /20–50萬\s+每輪約/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /47%　壓縮0　\S/ }))?.text).toBeDefined()
    expect([surface, String(/raiden·Blender/), (await ui.find({ type: 'Text', text: /raiden·Blender/ }))?.text !== undefined]).toEqual([surface, String(/raiden·Blender/), true])
    expect([surface, String(/47%/), (await ui.find({ type: 'Text', text: /47%/ }))?.text !== undefined]).toEqual([surface, String(/47%/), true])
    expect([surface, String(/這一輪.*\$0\.50/), (await ui.find({ type: 'Text', text: /這一輪.*\$0\.50/ }))?.text !== undefined]).toEqual([surface, String(/這一輪.*\$0\.50/), true])
    expect([surface, String(/這一輪處理.*100\.0萬 token.*快取 90%/), (await ui.find({ type: 'Text', text: /這一輪處理.*100\.0萬 token.*快取 90%/ }))?.text !== undefined]).toEqual([surface, String(/這一輪處理.*100\.0萬 token.*快取 90%/), true])
    expect([surface, String(/每輪約 0\.\d\d%/), (await ui.find({ type: 'Text', text: /每輪約 0\.\d\d%/ }))?.text !== undefined]).toEqual([surface, String(/每輪約 0\.\d\d%/), true])
    expect([surface, String(/對話訊息/), (await ui.find({ type: 'Text', text: /對話訊息/ }))?.text !== undefined]).toEqual([surface, String(/對話訊息/), true])
    expect([surface, String(/gmail 0\.8萬/), (await ui.find({ type: 'Text', text: /gmail 0\.8萬/ }))?.text !== undefined]).toEqual([surface, String(/gmail 0\.8萬/), true])

    await ui.unmount()
  }
})

const BAND = {
  plugin: 'token-monitor',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

test('the band starts as one line, expands, and opens and closes the pane', async ($, on) => {
  const fake = engine(on)
  await $.session.start({ cwd: 'C:/work/raiden', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 473110, window: 1000000, percent: 47 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 14 },
      { kind: 'seven_day', percentUsed: 33, resetsAt: '2026-11-05T11:00:00Z' },
    ],
    changed: ['context', 'rateLimits'],
  })
  expect(fake.isPaneUp()).toBe(false)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /已用 47%/ }))?.text).toBeDefined()
    // 47% used of 8 cells: 4 solid cells left, 4 dotted cells used.
    expect((await ui.find({ type: 'Text', text: /^█{4}$/ }))?.text).toBe('████')
    expect((await ui.find({ type: 'Text', text: /^░{4}$/ }))?.text).toBe('░░░░')
    expect((await ui.find({ type: 'Text', text: /5h 14% · 週 33%/ }))?.text).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /用量狀態/ })).toBeUndefined()

    await ui.press({ key: 'band' })
    expect((await ui.find({ type: 'Text', text: /用量狀態/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /1 週限制/ }))?.text).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /11月5日 .* 重置/ }))?.text).toBeDefined()
    await ui.press({ key: 'band' })
    expect(await ui.find({ type: 'Text', text: /用量狀態/ })).toBeUndefined()

    await ui.press({ key: 'pane' })
    expect(fake.isPaneUp()).toBe(true)
    expect(await ui.find({ type: 'Button', text: /詳細 ◂/ })).toBeDefined()
    await ui.press({ key: 'pane' })
    expect(fake.isPaneUp()).toBe(false)
    await ui.unmount()
  }
})

test('the compact button falls back to a queued /compact when compacting directly is refused', async ($, on) => {
  const { toasts } = engine(on)
  const commands: { command: string; args?: string }[] = []
  on('session.compact', () => {
    throw new Error('not from a plugin here')
  })
  on('command.run', (_, e) => (commands.push({ command: e.command, args: e.args }), { text: '' }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ cwd: 'C:/work/raiden', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 473110, window: 1000000, percent: 47 },
    rateLimits: [],
    changed: ['context'],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'compact' })
  expect(commands.some(c => c.command === 'compact' && (c.args ?? '').includes('保留'))).toBe(true)
  expect(toasts.some(text => text.includes('已排入 /compact'))).toBe(true)
  await ui.unmount()
})

test('the pane splits tokens by context category and lists problems', async ($, on) => {
  engine(on)
  on('session.compact', () => {
    throw new Error('a turn is running')
  })
  on('command.run', () => ({ text: '' }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ cwd: 'C:\work\raiden', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 3; i++) {
    await $.turn.complete({
      reason: 'answer',
      answer: 'ok',
      durationMs: 1000,
      isAborted: false,
      turnId: `t${i}`,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 2000,
        output_tokens: 1000,
        cache_read_input_tokens: 900000,
        cache_creation_input_tokens: 97000,
      },
    })
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /本視窗累計 3 輪\s+近 3 輪/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /所有視窗 3 輪/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /對話訊息.*90%/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /系統工具.*10%/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /模型輸出\s+0\.3萬/ }))?.text).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /最近問題/ })).toBeUndefined()

  await ui.press({ key: 'compact' })
  expect((await ui.find({ type: 'Text', text: /最近問題　1 筆/ }))?.text).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /直接壓縮被拒：/ }))?.text).toBeDefined()
  await ui.unmount()
})

test('a turn far above the running average is flagged with its cause', async ($, on) => {
  const fake = engine(on)
  const toasts = fake.toasts
  on('ui.log', () => ({ value: undefined }))
  await $.session.start({ cwd: 'C:\work\raiden', surface: 'desktop', isInteractive: true })
  const turn = (i: number) =>
    $.turn.complete({
      reason: 'answer',
      answer: 'ok',
      durationMs: 1000,
      isAborted: false,
      turnId: `t${i}`,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 2000,
        output_tokens: 1000,
        cache_read_input_tokens: 90000,
        cache_creation_input_tokens: 7000,
      },
    })
  for (let i = 0; i < 7; i++) {
    fake.spend(0.1 + (i % 2) * 0.01, 0)
    await turn(i)
  }
  expect(toasts.some(t => t.startsWith('突增'))).toBe(false)

  fake.spend(1.5, 0)
  await turn(99)
  expect(toasts.join(' | ')).toMatch(/突增：這一輪 \$1\.50（平均 \$0\.\d\d 的 \d+\.\d 倍）/)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /突增消耗　1 次/ }))?.text).toBeDefined()
  await ui.unmount()
})

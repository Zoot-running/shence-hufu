/**
 * 虎符 L0 单元测试：状态机转移、账本折叠/去重/重派 seed、战役编排与恢复。
 */
import { describe, expect, it, vi } from 'vitest'
import { InvalidTransitionError, isActive, isTerminal, transition } from '../src/state-machine.ts'
import { HufuLedger } from '../src/ledger.ts'
import { HufuCampaign } from '../src/campaign.ts'
import { CampaignRegistry } from '../src/registry.ts'
import type { CampaignConfig, WorkItem } from '../src/types.ts'

const ITEM = (id: string, priority?: { tier: number; score: number }): WorkItem => ({ id, label: id, priority })

function makeCampaign(config: Partial<CampaignConfig> = {}) {
  let now = 0
  const dispatch = vi.fn(async () => {})
  const interrupt = vi.fn(async () => {})
  const board = { pathOf: (group: string) => `/boards/${group}/FINDINGS.md` }
  const campaign = new HufuCampaign(
    { concurrency: config.concurrency ?? 2, stallAfterMs: config.stallAfterMs ?? 1000, heartbeatMs: config.heartbeatMs ?? 90_000, budgetMs: config.budgetMs },
    { now: () => now, dispatch: { dispatch }, interrupt: { interrupt }, board },
  )
  return { campaign, dispatch: { dispatch }, interrupt: { interrupt }, board, tick: (ms: number) => { now += ms } }
}

describe('state-machine.transition', () => {
  it('queued -> dispatched', () => {
    expect(transition('queued', { type: 'dispatch', at: 0, seed: 1 })).toBe('dispatched')
  })
  it('dispatched -> help -> progress stays', () => {
    expect(transition('dispatched', { type: 'help', at: 1, seed: 1, reason: 'x' })).toBe('help')
    expect(transition('help', { type: 'progress', at: 2, seed: 1 })).toBe('help')
  })
  it('dispatched/help -> stalled', () => {
    expect(transition('dispatched', { type: 'stall', at: 2, seed: 1 })).toBe('stalled')
    expect(transition('help', { type: 'stall', at: 2, seed: 1 })).toBe('stalled')
  })
  it('stalled -> superseded', () => {
    expect(transition('stalled', { type: 'supersede', at: 3, seed: 1, reason: 'r' })).toBe('superseded')
  })
  it('active -> terminal kinds', () => {
    expect(transition('dispatched', { type: 'terminal', at: 4, seed: 1, kind: 'done' })).toBe('done')
    expect(transition('help', { type: 'terminal', at: 4, seed: 1, kind: 'failed' })).toBe('failed')
    expect(transition('stalled', { type: 'terminal', at: 4, seed: 1, kind: 'blocked' })).toBe('blocked')
  })
  it('superseded absorbs late terminal', () => {
    expect(transition('superseded', { type: 'terminal', at: 9, seed: 1, kind: 'done' })).toBe('superseded')
  })
  it('requeue from failed/stalled/superseded/blocked', () => {
    for (const from of ['stalled', 'failed', 'blocked', 'superseded'] as const) {
      expect(transition(from, { type: 'requeue', at: 5, seed: 2, reason: 'r' })).toBe('queued')
    }
  })
  it('cancel prunes queued and in-flight items to blocked', () => {
    expect(transition('queued', { type: 'cancel', at: 1, seed: 1, reason: 'x' })).toBe('blocked')
    expect(transition('dispatched', { type: 'cancel', at: 1, seed: 1, reason: 'x' })).toBe('blocked')
    expect(transition('help', { type: 'cancel', at: 1, seed: 1, reason: 'x' })).toBe('blocked')
    expect(transition('stalled', { type: 'cancel', at: 1, seed: 1, reason: 'x' })).toBe('blocked')
  })
  it('cancel is idempotent on terminal states', () => {
    expect(() => transition('done', { type: 'cancel', at: 1, seed: 1, reason: 'x' })).toThrow(InvalidTransitionError)
  })
  it('invalid transitions throw', () => {
    expect(() => transition('queued', { type: 'progress', at: 1, seed: 1 })).toThrow(InvalidTransitionError)
    expect(() => transition('done', { type: 'dispatch', at: 1, seed: 2 })).toThrow(InvalidTransitionError)
    expect(() => transition('done', { type: 'terminal', at: 1, seed: 1, kind: 'done' })).toThrow(InvalidTransitionError)
  })
  it('isTerminal / isActive', () => {
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('superseded')).toBe(true)
    expect(isTerminal('stalled')).toBe(false)
    expect(isActive('stalled')).toBe(true)
    expect(isActive('queued')).toBe(false)
  })
})

describe('HufuLedger', () => {
  it('folds a happy path', () => {
    const ledger = new HufuLedger()
    ledger.register(ITEM('a'))
    ledger.append('a', { type: 'dispatch', at: 0, seed: 1 })
    ledger.append('a', { type: 'progress', at: 5, seed: 1 })
    ledger.append('a', { type: 'terminal', at: 10, seed: 1, kind: 'done', detail: 'flag{abc}' })
    expect(ledger.view('a')!.state).toBe('done')
    expect(ledger.view('a')!.terminalDetail).toBe('flag{abc}')
  })
  it('requeue clears stale terminal detail', () => {
    const ledger = new HufuLedger()
    ledger.register(ITEM('a'))
    ledger.append('a', { type: 'dispatch', at: 0, seed: 1 })
    ledger.append('a', { type: 'terminal', at: 10, seed: 1, kind: 'done', detail: 'old' })
    ledger.append('a', { type: 'requeue', at: 20, seed: 2, reason: 'retry' })
    const view = ledger.view('a')!
    expect(view.state).toBe('queued')
    expect(view.seed).toBe(2)
    expect(view.terminalDetail).toBeUndefined()
  })
  it('superseded old seed absorbs late terminal report', () => {
    const ledger = new HufuLedger()
    ledger.register(ITEM('a'))
    ledger.append('a', { type: 'dispatch', at: 0, seed: 1 })
    ledger.append('a', { type: 'stall', at: 1000, seed: 1 })
    ledger.append('a', { type: 'supersede', at: 1001, seed: 1, reason: 'stall' })
    ledger.append('a', { type: 'requeue', at: 1001, seed: 2, reason: 'fresh seed' })
    ledger.append('a', { type: 'dispatch', at: 1002, seed: 2 })
    ledger.append('a', { type: 'terminal', at: 1003, seed: 1, kind: 'done' }) // 旧 seed 迟到
    const view = ledger.view('a')!
    expect(view.state).toBe('dispatched')
    expect(view.seed).toBe(2)
  })
  it('first event must be dispatch/requeue', () => {
    const ledger = new HufuLedger()
    ledger.register(ITEM('a'))
    expect(() => ledger.append('a', { type: 'progress', at: 0, seed: 1 })).toThrow(/first event/)
  })
  it('restore replays dump', () => {
    const ledger = new HufuLedger()
    ledger.register(ITEM('a'))
    ledger.append('a', { type: 'dispatch', at: 0, seed: 1 })
    ledger.append('a', { type: 'terminal', at: 1, seed: 1, kind: 'done' })
    const restored = HufuLedger.restore([ITEM('a')], ledger.dump())
    expect(restored.view('a')!.state).toBe('done')
  })
})

describe('HufuCampaign', () => {
  it('cancel prunes a queued item and frees the queue', async () => {
    const { campaign } = makeCampaign({ concurrency: 1 })
    campaign.add(ITEM('a'))
    campaign.cancel('a', 'superseded by a completed sibling')
    expect(campaign.ledger.view('a')!.state).toBe('blocked')
    expect(campaign.nextQueued()).toHaveLength(0)
    expect(campaign.freeSlots()).toBe(1)
  })
  it('cancel on a terminal item is absorbed idempotently', async () => {
    const { campaign, dispatch, tick } = makeCampaign({ concurrency: 1 })
    campaign.add(ITEM('a'))
    await campaign.dispatchNext()
    tick(1)
    campaign.report('a', 'done')
    expect(() => campaign.cancel('a', 'late prune')).not.toThrow()
    expect(campaign.ledger.view('a')!.state).toBe('done')
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1)
  })
  it('DAG: dependents stay queued until dependencies reach a terminal state', async () => {
    const { campaign, dispatch, tick } = makeCampaign({ concurrency: 2 })
    campaign.add(ITEM('a'))
    campaign.add({ ...ITEM('b'), dependsOn: ['a'] })
    await campaign.dispatchNext()
    tick(1)
    // a 在跑，b 依赖未满足 → 不可派
    expect(campaign.nextQueued()).toHaveLength(0)
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1)
    campaign.report('a', 'done')
    // a 终态 → b 就绪可派
    await campaign.dispatchNext()
    expect(dispatch.dispatch).toHaveBeenNthCalledWith(2, { ...ITEM('b'), dependsOn: ['a'] }, 1)
  })
  it('DAG: multiple trees run in parallel within free slots', async () => {
    const { campaign, dispatch, tick } = makeCampaign({ concurrency: 4 })
    campaign.add(ITEM('root1'))
    campaign.add(ITEM('root2'))
    campaign.add({ ...ITEM('leaf1'), dependsOn: ['root1'] })
    campaign.add({ ...ITEM('leaf2'), dependsOn: ['root2'] })
    await campaign.dispatchNext()
    await campaign.dispatchNext()
    expect(dispatch.dispatch).toHaveBeenCalledTimes(2)
    tick(1)
    campaign.report('root1', 'done')
    campaign.report('root2', 'failed')
    await campaign.dispatchNext()
    await campaign.dispatchNext()
    // 两棵树各自的叶子都就绪（root2 判负也满足"终态"语义）
    expect(dispatch.dispatch).toHaveBeenCalledTimes(4)
  })
  it('unknown dependency ids are treated as satisfied (no deadlock)', async () => {
    const { campaign, dispatch } = makeCampaign({ concurrency: 1 })
    campaign.add({ ...ITEM('b'), dependsOn: ['nonexistent'] })
    await campaign.dispatchNext()
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1)
  })
  it('boardPath relays the host board port per group', () => {
    const { campaign, board } = makeCampaign()
    expect(campaign.boardPath('g-18')).toBe('/boards/g-18/FINDINGS.md')
    void board
  })
  it('dispatches in priority order within free slots', async () => {
    const { campaign, dispatch, tick } = makeCampaign({ concurrency: 2 })
    campaign.add(ITEM('hard1', { tier: 2, score: 900 }))
    campaign.add(ITEM('easy2', { tier: 0, score: 200 }))
    campaign.add(ITEM('med3', { tier: 1, score: 500 }))
    campaign.add(ITEM('easy4', { tier: 0, score: 300 }))
    await campaign.dispatchNext()
    await campaign.dispatchNext()
    expect(campaign.open()).toHaveLength(2)
    // 派单顺序按优先级：easy4(300) 先于 easy2(200)；open() 按注册序返回。
    expect(dispatch.dispatch).toHaveBeenNthCalledWith(1, ITEM('easy4', { tier: 0, score: 300 }), 1)
    expect(dispatch.dispatch).toHaveBeenNthCalledWith(2, ITEM('easy2', { tier: 0, score: 200 }), 1)
    tick(1)
  })
  it('passes per-item model and reasoningEffort to the dispatch port', async () => {
    const { campaign, dispatch } = makeCampaign({ concurrency: 1 })
    campaign.add({ id: 'w1', label: 'p', model: 'glm-4.6', reasoningEffort: 'max', priority: { tier: 0, score: 1 } })
    await campaign.dispatchNext()
    const [item, seed] = dispatch.dispatch.mock.calls[0]!
    expect(item.model).toBe('glm-4.6')
    expect(item.reasoningEffort).toBe('max')
    expect(seed).toBe(1)
  })
  it('respects concurrency cap', async () => {
    const { campaign } = makeCampaign({ concurrency: 1 })
    campaign.add(ITEM('a'))
    campaign.add(ITEM('b'))
    await campaign.dispatchNext()
    expect(campaign.freeSlots()).toBe(0)
    expect(await campaign.dispatchNext()).toBeUndefined()
  })
  it('report completes item and frees a slot for the next', async () => {
    const { campaign } = makeCampaign({ concurrency: 1 })
    campaign.add(ITEM('a'))
    campaign.add(ITEM('b'))
    await campaign.dispatchNext()
    campaign.report('a', 'done')
    expect(campaign.ledger.view('a')!.state).toBe('done')
    await campaign.dispatchNext()
    expect(campaign.ledger.view('b')!.state).toBe('dispatched')
  })
  it('rejects a terminal report on a never-dispatched item', () => {
    const { campaign } = makeCampaign()
    campaign.add(ITEM('a'))
    expect(() => campaign.report('a', 'done')).toThrow(InvalidTransitionError)
  })
  it('stall -> supersede + requeue with seed+1, then redispatch uses new seed', async () => {
    const { campaign, interrupt, tick } = makeCampaign({ concurrency: 2, stallAfterMs: 1000 })
    campaign.add(ITEM('a'))
    await campaign.dispatchNext()
    tick(1100)
    const stalled = await campaign.stallCheck()
    expect(stalled).toEqual(['a'])
    expect(interrupt.interrupt).toHaveBeenCalledWith(ITEM('a'), 1)
    expect(campaign.ledger.view('a')!.state).toBe('queued')
    expect(campaign.ledger.view('a')!.seed).toBe(2)
    await campaign.dispatchNext()
    expect(campaign.ledger.view('a')!.state).toBe('dispatched')
    expect(campaign.ledger.view('a')!.seed).toBe(2)
  })
  it('isComplete when all terminal', async () => {
    const { campaign } = makeCampaign({ concurrency: 2 })
    campaign.add(ITEM('a'))
    campaign.add(ITEM('b'))
    await campaign.dispatchNext()
    await campaign.dispatchNext()
    expect(campaign.isComplete()).toBe(false)
    campaign.report('a', 'done')
    campaign.report('b', 'blocked')
    expect(campaign.isComplete()).toBe(true)
  })
  it('serialize + restore preserves state', async () => {
    const { campaign, tick } = makeCampaign({ concurrency: 1 })
    campaign.add(ITEM('a'))
    campaign.add(ITEM('b'))
    await campaign.dispatchNext()
    tick(50)
    const data = campaign.serialize()
    let now2 = 1000
    const restored = HufuCampaign.restore(data, {
      now: () => now2,
      dispatch: { dispatch: async () => {} },
      interrupt: { interrupt: async () => {} },
    })
    expect(restored.ledger.view('a')!.state).toBe('dispatched')
    expect(restored.ledger.view('b')!.state).toBe('queued')
    expect(restored.open()).toHaveLength(1)
  })
})

describe('CampaignRegistry', () => {
  it('registers, gets, lists, and dedupes collect deliveries', () => {
    const registry = new CampaignRegistry<object>()
    const a = registry.register({ name: 'a' })
    const b = registry.register({ name: 'b' })
    expect(registry.get(a)).toEqual({ name: 'a' })
    expect(registry.ids()).toEqual([a, b])
    expect(registry.markDelivered(a, 'i1')).toBe(true)
    expect(registry.markDelivered(a, 'i1')).toBe(false)
    expect(registry.markDelivered(a, 'i2')).toBe(true)
  })
})

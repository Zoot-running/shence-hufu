/**
 * 虎符账本：工作项事件追加日志 + 折叠视图 + 恢复重放。
 * 重复报告去重：superseded 的旧 seed 迟到 terminal 被吸收，不改变状态。
 * @module @shence/hufu/ledger
 */

import { isTerminal, transition } from './state-machine.ts'
import type { LedgerEvent, WorkItem, WorkState, WorkView } from './types.ts'

interface SeedFacts {
  dispatchedAt?: number
  lastProgressAt?: number
}

export class HufuLedger {
  /** itemId → 有序事件列表。 */
  private readonly events = new Map<string, LedgerEvent[]>()
  /** itemId → WorkItem（注册时快照）。 */
  private readonly items = new Map<string, WorkItem>()

  /** 注册工作项（幂等）。 */
  register(item: WorkItem): void {
    if (this.items.has(item.id)) return
    this.items.set(item.id, item)
    this.events.set(item.id, [])
  }

  /** 追记事件：校验转移并记录；非法转移抛 InvalidTransitionError。 */
  append(itemId: string, event: LedgerEvent): void {
    const list = this.events.get(itemId)
    if (list === undefined) throw new Error(`hufu: unknown work item "${itemId}"`)
    const current = this.foldEvents(list)
    if (current === undefined) {
      if (event.type === 'dispatch' || event.type === 'requeue' || event.type === 'cancel') {
        list.push(event)
        return
      }
      throw new Error(`hufu: first event for "${itemId}" must be dispatch/requeue/cancel, got ${event.type}`)
    }
    // 新 seed 的 dispatch/requeue 重开状态，无需经 transition 校验。
    if ((event.type === 'dispatch' && event.seed > this.currentSeed(list)) || event.type === 'requeue') {
      list.push(event)
      return
    }
    transition(current, event) // 校验（副作用在通过后）
    list.push(event)
  }

  /** 当前最大 seed。 */
  private currentSeed(list: readonly LedgerEvent[]): number {
    let seed = 0
    for (const event of list) {
      if (event.type === 'dispatch' && event.seed > seed) seed = event.seed
    }
    return seed
  }

  /** 显式事件折叠（首事件 dispatch→dispatched；cancel→blocked；requeue→queued；新 seed 重开；旧 seed 事件吸收）。 */
  private foldEvents(list: readonly LedgerEvent[]): WorkState | undefined {
    if (list.length === 0) return undefined
    let state: WorkState = list[0]!.type === 'dispatch' ? 'dispatched' : list[0]!.type === 'cancel' ? 'blocked' : 'queued'
    let seed = list[0]!.seed
    for (let i = 1; i < list.length; i++) {
      const event = list[i]!
      if (event.type === 'dispatch' && event.seed > seed) {
        seed = event.seed
        state = 'dispatched'
        continue
      }
      if (event.type === 'requeue') {
        seed = event.seed
        state = 'queued'
        continue
      }
      // 旧 seed 的迟到事件一律吸收（去重：尤其是 superseded 后的 terminal）。
      if (event.seed !== seed) continue
      state = transition(state, event)
    }
    return state
  }

  /** 工作项当前视图。 */
  view(itemId: string): WorkView | undefined {
    const item = this.items.get(itemId)
    const list = this.events.get(itemId)
    if (item === undefined || list === undefined) return undefined
    if (list.length === 0) {
      return { item, state: 'queued', seed: 1, redispatchRequested: false }
    }
    const state = this.foldEvents(list)
    if (state === undefined) return undefined
    const facts: SeedFacts = {}
    let seed = 1
    let redispatchRequested = false
    let terminalDetail: string | undefined
    for (const event of list) {
      if (event.type === 'dispatch') {
        seed = event.seed
        facts.dispatchedAt = event.at
        terminalDetail = undefined
      } else if (event.type === 'progress') {
        facts.lastProgressAt = event.at
      } else if (event.type === 'supersede') {
        redispatchRequested = true
      } else if (event.type === 'requeue') {
        seed = event.seed // 新 seed（重派）
        redispatchRequested = false
        terminalDetail = undefined
      } else if (event.type === 'terminal' && event.seed === seed) {
        terminalDetail = event.detail
      }
    }
    return {
      item,
      state,
      seed,
      dispatchedAt: facts.dispatchedAt,
      lastProgressAt: facts.lastProgressAt,
      redispatchRequested,
      terminalDetail,
    }
  }

  /** 全部视图（注册顺序）。 */
  views(): WorkView[] {
    return [...this.items.keys()].map(id => this.view(id)!).filter(v => v !== undefined)
  }

  /** 活跃项（占用槽位）。 */
  open(): WorkView[] {
    return this.views().filter(v => v.state === 'dispatched' || v.state === 'help' || v.state === 'stalled')
  }

  /** 排队项（可派单）。 */
  queued(): WorkView[] {
    return this.views().filter(v => v.state === 'queued')
  }

  /** 终态项。 */
  terminal(): WorkView[] {
    return this.views().filter(v => isTerminal(v.state))
  }

  /** 全部事件（序列化/恢复用）。 */
  dump(): Array<{ itemId: string; events: LedgerEvent[] }> {
    return [...this.events.entries()].map(([itemId, events]) => ({ itemId, events: [...events] }))
  }

  /** 由 dump 恢复（崩溃恢复 = 账本重放）。 */
  static restore(items: WorkItem[], dump: Array<{ itemId: string; events: LedgerEvent[] }>): HufuLedger {
    const ledger = new HufuLedger()
    for (const item of items) ledger.register(item)
    for (const { itemId, events } of dump) {
      ledger.register({ id: itemId, label: itemId })
      for (const event of events) ledger.append(itemId, event)
    }
    return ledger
  }
}

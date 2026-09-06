/**
 * 虎符战役编排（ADR-001 核心）：队列排序、槽位分配、stall 检测与重派、心跳、恢复。
 * 纯逻辑 + 注入端口（now/dispatch/interrupt）；宿主绑定在 src/index.ts。
 * @module @shence/hufu/campaign
 */

import { InvalidTransitionError, isActive, isTerminal } from './state-machine.ts'
import { HufuLedger } from './ledger.ts'
import type { BoardPort, CampaignConfig, DispatchPort, InterruptPort, LedgerEvent, WorkItem, WorkView } from './types.ts'

export interface CampaignPorts {
  now(): number
  dispatch: DispatchPort
  interrupt: InterruptPort
  board: BoardPort
}

/** 队列排序：priority.tier 升序 → score 降序 → 注册顺序稳定。 */
function byPriority(a: WorkView, b: WorkView): number {
  const pa = a.item.priority
  const pb = b.item.priority
  if (pa !== undefined && pb !== undefined) {
    if (pa.tier !== pb.tier) return pa.tier - pb.tier
    if (pa.score !== pb.score) return pb.score - pa.score
  }
  if (pa !== undefined) return -1
  if (pb !== undefined) return 1
  return 0
}

export class HufuCampaign {
  readonly ledger = new HufuLedger()

  constructor(
    readonly config: CampaignConfig,
    private readonly ports: CampaignPorts,
  ) {}

  /** 注册工作项（幂等）。 */
  add(item: WorkItem): void {
    this.ledger.register(item)
  }

  /** 可派单的排队项：依赖全部终态（图状事务就绪）后按优先级排序。 */
  nextQueued(): WorkView[] {
    return this.ledger.queued().filter(v => this.dependenciesSatisfied(v)).sort(byPriority)
  }

  /** 依赖判定：未知依赖视为已满足（防御死锁），否则必须全部终态。 */
  dependenciesSatisfied(view: WorkView): boolean {
    const depends = view.item.dependsOn ?? []
    return depends.every(id => {
      const dep = this.ledger.view(id)
      return dep === undefined || isTerminal(dep.state)
    })
  }

  /** 共享板路径（并行工人互相联系的泛化信道；宿主绑定实现）。 */
  boardPath(group: string): string {
    return this.ports.board.pathOf(group)
  }

  /** 活跃项（占用槽位）。 */
  open(): WorkView[] {
    return this.ledger.open()
  }

  /** 剩余可派单槽位。 */
  freeSlots(): number {
    const budgetExpired = this.config.budgetMs !== undefined
      && this.ports.now() - (this.startedAt() ?? this.ports.now()) > this.config.budgetMs
    if (budgetExpired) return 0
    return Math.max(0, this.config.concurrency - this.open().length)
  }

  /** 战役首个事件时间戳（预算起点）。 */
  private startedAt(): number | undefined {
    for (const view of this.ledger.views()) {
      if (view.dispatchedAt !== undefined) return view.dispatchedAt
    }
    return undefined
  }

  /** 派单一个排队项（返回视图；无槽位/无排队返回 undefined）。 */
  async dispatchNext(): Promise<WorkView | undefined> {
    if (this.freeSlots() <= 0) return undefined
    const next = this.nextQueued()[0]
    if (next === undefined) return undefined
    const at = this.ports.now()
    const seed = next.seed
    this.ledger.append(next.item.id, { type: 'dispatch', at, seed })
    await this.ports.dispatch.dispatch(next.item, seed)
    return this.ledger.view(next.item.id)
  }

  /** 工作项进展（宿主轮询 progress.log 等）。 */
  progress(itemId: string, note?: string): void {
    const view = this.ledger.view(itemId)
    if (view === undefined) throw new Error(`hufu: unknown work item "${itemId}"`)
    this.ledger.append(itemId, { type: 'progress', at: this.ports.now(), seed: view.seed, note })
  }

  /** 工作项请求外部帮助（hint 等在平台侧执行；虎符只记录）。 */
  help(itemId: string, reason: string): void {
    const view = this.ledger.view(itemId)
    if (view === undefined) throw new Error(`hufu: unknown work item "${itemId}"`)
    this.ledger.append(itemId, { type: 'help', at: this.ports.now(), seed: view.seed, reason })
  }

  /** 终态报告（子代理完成通知）。superseded 旧 seed 的迟到报告被吸收。 */
  report(itemId: string, kind: 'done' | 'failed' | 'blocked', detail?: string): void {
    const view = this.ledger.view(itemId)
    if (view === undefined) throw new Error(`hufu: unknown work item "${itemId}"`)
    if (view.state === 'queued') {
      throw new InvalidTransitionError('queued', 'terminal')
    }
    if (isTerminal(view.state)) {
      if (view.state === 'superseded') return // 去重吸收
      return // 已完成项忽略重复报告
    }
    this.ledger.append(itemId, { type: 'terminal', at: this.ports.now(), seed: view.seed, kind, detail })
  }

  /** 剪枝：撤销排队/在途项（同题已破、思路废弃等）→ blocked 终态，释放槽位与队列。 */
  cancel(itemId: string, reason: string): void {
    const view = this.ledger.view(itemId)
    if (view === undefined) throw new Error(`hufu: unknown work item "${itemId}"`)
    if (isTerminal(view.state)) return // 已终态：幂等吸收
    this.ledger.append(itemId, { type: 'cancel', at: this.ports.now(), seed: view.seed, reason })
  }

  /**
   * stall 检测：超过 stallAfterMs 无进展 → 标记 stall；
   * 若 redispatchRequested 为假 → supersede + requeue（seed+1），并中断旧 seed。
   */
  async stallCheck(): Promise<string[]> {
    const now = this.ports.now()
    const stalledIds: string[] = []
    for (const view of this.ledger.open()) {
      if (view.state !== 'dispatched' && view.state !== 'help') continue
      const last = view.lastProgressAt ?? view.dispatchedAt
      if (last === undefined || now - last < this.config.stallAfterMs) continue
      this.ledger.append(view.item.id, { type: 'stall', at: now, seed: view.seed })
      if (!view.redispatchRequested) {
        await this.ports.interrupt.interrupt(view.item, view.seed)
        this.ledger.append(view.item.id, {
          type: 'supersede', at: now, seed: view.seed,
          reason: `stall after ${this.config.stallAfterMs}ms without progress`,
        })
        this.ledger.append(view.item.id, { type: 'requeue', at: now, seed: view.seed + 1, reason: 'redispatch with fresh seed' })
        stalledIds.push(view.item.id)
      }
    }
    return stalledIds
  }

  /** 心跳间隔（保活后台任务必须在该时限内结算并续挂）。 */
  heartbeatMs(): number {
    return this.config.heartbeatMs
  }

  /** 完成判定：预算耗尽或全部工作项终态。 */
  isComplete(): boolean {
    if (this.config.budgetMs !== undefined && this.startedAt() !== undefined
      && this.ports.now() - this.startedAt()! > this.config.budgetMs) return true
    const views = this.ledger.views()
    return views.length > 0 && views.every(v => isTerminal(v.state))
  }

  /** 进度快照。 */
  summary(): { total: number; open: number; done: number; failed: number; blocked: number; superseded: number; queued: number } {
    const views = this.ledger.views()
    const count = (fn: (v: WorkView) => boolean): number => views.filter(fn).length
    return {
      total: views.length,
      open: count(v => isActive(v.state)),
      done: count(v => v.state === 'done'),
      failed: count(v => v.state === 'failed'),
      blocked: count(v => v.state === 'blocked'),
      superseded: count(v => v.state === 'superseded'),
      queued: count(v => v.state === 'queued'),
    }
  }

  /** 序列化（崩溃恢复 = 账本重放）。 */
  serialize(): { config: CampaignConfig; items: WorkItem[]; dump: ReturnType<HufuLedger['dump']> } {
    return {
      config: this.config,
      items: this.ledger.views().map(v => v.item),
      dump: this.ledger.dump(),
    }
  }

  /** 恢复（重放账本）。 */
  static restore(
    data: ReturnType<HufuCampaign['serialize']>,
    ports: CampaignPorts,
  ): HufuCampaign {
    const campaign = new HufuCampaign(data.config, ports)
    for (const item of data.items) campaign.ledger.register(item)
    for (const { itemId, events } of data.dump) {
      for (const event of events) campaign.ledger.append(itemId, event)
    }
    return campaign
  }
}

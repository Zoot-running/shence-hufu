/**
 * 虎符通用竞争资源队列原语(v7.6)。
 * 模仿 CPU 就绪队列: 单一授权点、FIFO 公平、同 holderId 合并等待位、释放即唤醒队首。
 * 使用方注入 canGrant/grant——虎符只管排队与公平, 不感知具体资源(平台容器槽等)。
 * 死锁不变量: 每 holder 单资源获取 + 单一授权点 ⇒ 无"持有并等待"环; 将来若出现
 * 一题多资源, 使用方必须按资源排序依序申请(注释留位, 本次不实现)。
 * @module @shence/hufu/resource-queue
 */

export type ResourceGrantResult =
  | { status: 'granted' }
  | { status: 'timeout'; position: number }
  | { status: 'evicted'; reason: string }

export interface ResourceQueueConfig {
  /** 同时可授予数(如平台 3 容器槽)。 */
  capacity: number
  /** 判定"现在是否可授予"(使用方注入; 每次尝试授予前都调用, 不得缓存)。 */
  canGrant(): Promise<boolean>
  /** 授予动作(使用方执行真正的资源获取, 如 start_container); 抛错 = 授予失败, 队首重排等待。 */
  grant?(holderId: string): Promise<void>
  /** 轮询间隔(ms)。默认 2000。 */
  pollMs?: number
  /** 缺省等待超时(ms)。默认 300_000。 */
  defaultTimeoutMs?: number
}

interface Waiter {
  holderId: string
  enqueuedAt: number
  position: number
  resolve: (r: ResourceGrantResult) => void
  timer?: ReturnType<typeof setTimeout>
}

export class ResourceQueue {
  private granted = 0
  private granting = false
  private readonly queue: Waiter[] = []
  private readonly pending = new Map<string, Promise<ResourceGrantResult>>() // 同 holderId 合并: 后到者共享同一结果
  private readonly cfg: Required<Pick<ResourceQueueConfig, 'capacity' | 'canGrant' | 'pollMs' | 'defaultTimeoutMs'>> & { grant?: (holderId: string) => Promise<void> }
  private pumpTimer?: ReturnType<typeof setInterval>
  private pumpRunning = false

  constructor(config: ResourceQueueConfig) {
    if (config.capacity < 1) throw new Error('hufu: resource queue capacity must be >= 1')
    this.cfg = {
      capacity: config.capacity,
      canGrant: config.canGrant,
      grant: config.grant,
      pollMs: config.pollMs ?? 2000,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 300_000,
    }
  }

  /** 已授予数(占用中)。 */
  grantedCount(): number {
    return this.granted
  }

  /** 排队快照: holderId + 位置(1-based)。 */
  waiters(): Array<{ holderId: string; position: number; waitingMs: number }> {
    const now = Date.now()
    return this.queue.map((w, i) => ({ holderId: w.holderId, position: i + 1, waitingMs: now - w.enqueuedAt }))
  }

  /**
   * 申请资源。同 holderId 合并等待位(后到者共享先到者的结果——同题多执行者共享一个资源)。
   * 可授予且无人排队 → 立即尝试授予; 否则排队, 每 pollMs 泵一次。
   */
  acquire(holderId: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ResourceGrantResult> {
    const existing = this.pending.get(holderId)
    if (existing !== undefined) return existing
    const promise = new Promise<ResourceGrantResult>((resolve) => {
      const waiter: Waiter = { holderId, enqueuedAt: Date.now(), position: this.queue.length + 1, resolve }
      const timeoutMs = opts?.timeoutMs ?? this.cfg.defaultTimeoutMs
      waiter.timer = setTimeout(() => {
        const idx = this.queue.indexOf(waiter)
        if (idx < 0) return // 已授予/已出队
        this.queue.splice(idx, 1)
        this.refreshPositions()
        this.pending.delete(holderId)
        resolve({ status: 'timeout', position: idx + 1 })
        this.stopPumpIfIdle()
      }, timeoutMs)
      ;(waiter.timer as { unref?: () => void }).unref?.()
      opts?.signal?.addEventListener('abort', () => {
        const idx = this.queue.indexOf(waiter)
        if (idx < 0) return
        this.queue.splice(idx, 1)
        this.refreshPositions()
        this.pending.delete(holderId)
        resolve({ status: 'evicted', reason: 'aborted' })
        this.stopPumpIfIdle()
      }, { once: true })
      this.queue.push(waiter)
      this.startPump()
    })
    this.pending.set(holderId, promise)
    void promise.finally(() => { if (this.pending.get(holderId) === promise) this.pending.delete(holderId) })
    return promise
  }

  /** 释放一次授予(使用方在资源关闭出口调用); 立即尝试唤醒队首。 */
  async release(): Promise<void> {
    if (this.granted > 0) this.granted -= 1
    await this.pump()
  }

  /** 终态/中断出队: 摘除该 holderId 的全部排队位并告知原因(轮给下一家)。 */
  evict(holderId: string, reason: string): boolean {
    let removed = false
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const w = this.queue[i]!
      if (w.holderId !== holderId) continue
      if (w.timer !== undefined) clearTimeout(w.timer)
      this.queue.splice(i, 1)
      this.pending.delete(holderId)
      w.resolve({ status: 'evicted', reason })
      removed = true
    }
    if (removed) this.refreshPositions()
    this.stopPumpIfIdle()
    return removed
  }

  private refreshPositions(): void {
    this.queue.forEach((w, i) => { w.position = i + 1 })
  }

  private startPump(): void {
    if (this.pumpTimer !== undefined) return
    this.pumpTimer = setInterval(() => { void this.pump() }, this.cfg.pollMs)
    ;(this.pumpTimer as { unref?: () => void }).unref?.()
  }

  private stopPumpIfIdle(): void {
    if (this.queue.length === 0 && this.pumpTimer !== undefined) {
      clearInterval(this.pumpTimer)
      this.pumpTimer = undefined
    }
  }

  /** 泵一次: 有队、有容量、可授予 → 队首出队执行 grant。单一授权点(granting 互斥)。 */
  private async pump(): Promise<void> {
    if (this.pumpRunning) return
    this.pumpRunning = true
    try {
      if (this.granting) return
      if (this.queue.length === 0 || this.granted >= this.cfg.capacity) return
      let can = false
      try { can = await this.cfg.canGrant() } catch { can = false }
      if (!can) return
      const waiter = this.queue.shift()!
      this.refreshPositions()
      this.granting = true
      try {
        if (this.cfg.grant !== undefined) await this.cfg.grant(waiter.holderId)
        this.granted += 1
        if (waiter.timer !== undefined) clearTimeout(waiter.timer)
        this.pending.delete(waiter.holderId)
        waiter.resolve({ status: 'granted' })
      } catch {
        // 授予失败(平台 409 等): 队首重排, 下个 tick 再试。
        this.queue.unshift(waiter)
        this.refreshPositions()
      } finally {
        this.granting = false
      }
      this.stopPumpIfIdle()
    } finally {
      this.pumpRunning = false
    }
  }
}

/**
 * 虎符战役注册表（纯逻辑，L0 可测）。
 * 服务层持有战役集合，供 agent 工具按 id 调度；collect 交付去重（已交结果不回吐）。
 * @module @shence/hufu/registry
 */

export interface TerminalDelivery {
  itemId: string
  state: string
  model?: string
  detail?: string
}

export class CampaignRegistry<T> {
  private readonly campaigns = new Map<string, T>()
  private readonly delivered = new Map<string, Set<string>>()
  private seq = 0

  register(campaign: T): string {
    this.seq += 1
    const id = `campaign-${this.seq}`
    this.campaigns.set(id, campaign)
    this.delivered.set(id, new Set())
    return id
  }

  get(id: string): T | undefined {
    return this.campaigns.get(id)
  }

  ids(): string[] {
    return [...this.campaigns.keys()]
  }

  /** collect 交付去重：首次返回 true 并标记；已交付返回 false。 */
  markDelivered(campaignId: string, itemId: string): boolean {
    const set = this.delivered.get(campaignId)
    if (set === undefined) return false
    if (set.has(itemId)) return false
    set.add(itemId)
    return true
  }
}

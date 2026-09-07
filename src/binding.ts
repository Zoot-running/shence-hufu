/**
 * 虎符宿主绑定：把 HufuCampaign 端口接到 DSH 宿主能力。
 * 派单：优先经集思通道（ctx.jisi，按次模型）；无集思回退 DSH 原生 subagent。
 * 结算：派单即挂 .then 自动喂 campaign.report（终态去重由账本保证）。
 * @module @shence/hufu/binding
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { HufuCampaign } from './campaign.ts'
import { CampaignRegistry } from './registry.ts'
import type { BoardPort, CampaignConfig, DispatchPort, InterruptPort, WorkItem } from './types.ts'

interface JisiLike {
  delegate(parent: Agent, work: { prompt: string }, opts?: {
    model?: string
    provider?: string
    reasoningEffort?: string
    background?: boolean
  }): { ref: { id: string }; report: Promise<{ status: 'completed' | 'failed' | 'blocked'; text: string }> }
  continue(parent: Agent, childId: string, message: string): Promise<void>
}

function textOfBlocks(output: readonly ContentBlock[] | undefined): string {
  if (output === undefined) return ''
  return output.filter(b => b.type === 'text').map(b => (b.type === 'text' ? b.text : '')).join('')
}

/** 战役持有者（构造期间回填，供端口回调引用）。 */
export interface CampaignHolder {
  campaign?: HufuCampaign
}

/** 构造宿主端口：派单经集思（无则 DSH 原生一次性子代理）。 */
export function createHostPorts(
  ctx: Context,
  agent: Agent,
  holder: CampaignHolder,
  subagentProvider: string,
  jisi: JisiLike | undefined,
): { dispatch: DispatchPort; interrupt: InterruptPort; continuables: Map<string, { childId: string; parent: Agent }> } {
  const continuables = new Map<string, { childId: string; parent: Agent }>()

  const feed = (item: WorkItem, report: { status: string; text: string }): void => {
    const campaign = holder.campaign
    if (campaign === undefined) return
    const kind = report.status === 'completed' ? 'done' as const : 'failed' as const
    try {
      campaign.report(item.id, kind, report.text.slice(0, 65_536))
    } catch {
      // 账本终态冲突（superseded/重复）：吸收。
    }
  }

  const dispatch: DispatchPort = {
    async dispatch(item, _seed) {
      const work = { prompt: item.label }
      const opts = {
        background: false as const,
        ...(item.model !== undefined ? { model: item.model } : {}),
        ...(item.reasoningEffort !== undefined ? { reasoningEffort: item.reasoningEffort } : {}),
      }
      if (jisi !== undefined) {
        // continuable 执行者：后台派单（子代理跨轮续战）；终态由调用方（主 agent）显式 report。
        if (item.continuable === true) {
          const result = jisi.delegate(agent, work, { ...opts, background: true })
          continuables.set(item.id, { childId: result.ref.id, parent: agent })
          // 启动失败要显式落账；成功则保持 dispatched，等主 agent 判断后 report。
          void result.report.then(report => {
            if (report.status === 'failed') feed(item, report)
          })
          return
        }
        const result = jisi.delegate(agent, work, opts)
        void result.report.then(report => feed(item, report))
        return
      }
      // 回退：DSH 原生一次性子代理。
      const run = ctx.subagents.start(subagentProvider, {
        label: `hufu-${item.id}`,
        prompt: [{ type: 'text', text: item.label }] as ContentBlock[],
        parent: agent,
        signal: new AbortController().signal,
        ...(item.model !== undefined || item.reasoningEffort !== undefined ? {
          agentOptions: {
            ...(item.model !== undefined ? { model: item.model } : {}),
            ...(item.reasoningEffort !== undefined ? { reasoningEffort: item.reasoningEffort } : {}),
          },
        } : {}),
      })
      void run.then(async (r) => {
        const result = await r.result
        void settleRun(r)
        feed(item, {
          status: result.stopReason === 'completed' ? 'completed' : 'failed',
          text: textOfBlocks(result.output),
        })
      })
    },
  }

  const interrupt: InterruptPort = {
    async interrupt(item, seed) {
      // v1：宿主中断（interrupt_agent）在工具层不可达；打日志并依赖重派 seed 隔离。
      const logger = ctx.logger
      if (logger !== undefined) logger('hufu').info(`interrupt requested for ${item.id}#${seed} (no-op in v1 binding)`)
    },
  }

  const board: BoardPort = {
    pathOf(group) {
      const safe = group.replace(/[^A-Za-z0-9._-]/g, '_')
      const dir = join(process.cwd(), 'boards', safe)
      mkdirSync(dir, { recursive: true })
      return join(dir, 'FINDINGS.md')
    },
  }

  return { dispatch, interrupt, board, continuables }
}

/** ctx.hufu 服务面。 */
export interface HufuService {
  /** 创建并注册战役；返回 id + 战役对象。 */
  createCampaign(agent: Agent, config: CampaignConfig, items: WorkItem[]): { id: string; campaign: HufuCampaign }
  /** 按 id 取战役（编程消费方：runner 等）。 */
  get(id: string): HufuCampaign | undefined
  /** 全部战役 id。 */
  ids(): string[]
  /** 入队一个工作项（模型/思考强度/依赖/共享板都在这里——调度语义归虎符）。 */
  enqueue(id: string, item: WorkItem): string
  /** 派发全部就绪排队项（槽位空闲即派，永不空等），返回派发数。 */
  dispatch(id: string): Promise<number>
  /** 收终态（交付去重）：已结算工作项的 id/状态/模型/详情。 */
  collect(id: string): Array<{ itemId: string; state: string; model?: string; detail?: string }>
  /** 剪枝：撤销排队/在途项。 */
  cancel(id: string, itemId: string, reason: string): void
  /** 显式终态报告（continuable 执行者的结算入口：主 agent 判断后落账）。 */
  report(id: string, itemId: string, kind: 'done' | 'failed' | 'blocked', detail?: string): void
  /** 续聊 continuable 执行者（保留原生上下文跨轮续战）。 */
  continue(id: string, itemId: string, message: string): Promise<void>
  /** 战役状态摘要。 */
  status(id: string): { open: number; queued: number; done: number; failed: number; blocked: number }
  /** 共享板路径。 */
  boardPath(id: string, group: string): string
}

export function createHufuService(ctx: Context, subagentProvider: string): HufuService {
  const jisi = (ctx as unknown as { get?: (name: string) => unknown }).get?.('jisi') as JisiLike | undefined
  const registry = new CampaignRegistry<HufuCampaign>()
  const continuablesByCampaign = new Map<string, Map<string, { childId: string; parent: Agent }>>()
  const require = (id: string): HufuCampaign => {
    const campaign = registry.get(id)
    if (campaign === undefined) throw new Error(`hufu: unknown campaign "${id}"`)
    return campaign
  }
  return {
    createCampaign(agent, config, items) {
      const holder: CampaignHolder = {}
      const ports = createHostPorts(ctx, agent, holder, subagentProvider, jisi)
      const campaign = new HufuCampaign(config, {
        now: () => Date.now(),
        ...ports,
      })
      holder.campaign = campaign
      for (const item of items) campaign.add(item)
      const id = registry.register(campaign)
      continuablesByCampaign.set(id, ports.continuables)
      return { id, campaign }
    },
    get: id => registry.get(id),
    ids: () => registry.ids(),
    enqueue(id, item) {
      require(id).add(item)
      return item.id
    },
    async dispatch(id) {
      const campaign = require(id)
      let count = 0
      while (campaign.freeSlots() > 0 && campaign.nextQueued().length > 0) {
        await campaign.dispatchNext()
        count += 1
      }
      return count
    },
    collect(id) {
      const campaign = require(id)
      const out: Array<{ itemId: string; state: string; model?: string; detail?: string }> = []
      for (const view of campaign.ledger.views()) {
        if (view.state !== 'done' && view.state !== 'failed' && view.state !== 'blocked') continue
        if (!registry.markDelivered(id, view.item.id)) continue
        out.push({
          itemId: view.item.id,
          state: view.state,
          model: view.item.model,
          detail: view.terminalDetail,
        })
      }
      return out
    },
    cancel(id, itemId, reason) {
      require(id).cancel(itemId, reason)
    },
    report(id, itemId, kind, detail) {
      require(id).report(itemId, kind, detail)
    },
    async continue(id, itemId, message) {
      const entry = continuablesByCampaign.get(id)?.get(itemId)
      if (entry === undefined) throw new Error(`hufu: no continuable child for "${itemId}"`)
      if (jisi === undefined) throw new Error('hufu: jisi channel required for continuable children')
      await jisi.continue(entry.parent, entry.childId, message)
    },
    status(id) {
      const views = require(id).ledger.views()
      const count = (fn: (state: string) => boolean): number => views.filter(v => fn(v.state)).length
      return {
        open: count(s => s === 'dispatched' || s === 'help' || s === 'stalled'),
        queued: count(s => s === 'queued'),
        done: count(s => s === 'done'),
        failed: count(s => s === 'failed'),
        blocked: count(s => s === 'blocked'),
      }
    },
    boardPath: (id, group) => require(id).boardPath(group),
  }
}

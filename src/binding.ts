/**
 * 虎符宿主绑定：把 HufuCampaign 端口接到 DSH 宿主能力。
 * 派单：优先经集思通道（ctx.jisi，按次模型）；无集思回退 DSH 原生 subagent。
 * 结算：派单即挂 .then 自动喂 campaign.report（终态去重由账本保证）。
 * @module @shence/hufu/binding
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { HufuCampaign } from './campaign.ts'
import type { CampaignConfig, DispatchPort, InterruptPort, WorkItem } from './types.ts'

interface JisiLike {
  delegate(parent: Agent, work: { prompt: string }, opts?: {
    model?: string
    provider?: string
    background?: boolean
  }): { report: Promise<{ status: 'completed' | 'failed' | 'blocked'; text: string }> }
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
): { dispatch: DispatchPort; interrupt: InterruptPort } {
  const jisi = (ctx as unknown as { get?: (name: string) => unknown }).get?.('jisi') as JisiLike | undefined

  const feed = (item: WorkItem, report: { status: string; text: string }): void => {
    const campaign = holder.campaign
    if (campaign === undefined) return
    const kind = report.status === 'completed' ? 'done' as const : 'failed' as const
    try {
      campaign.report(item.id, kind, report.text.slice(0, 200))
    } catch {
      // 账本终态冲突（superseded/重复）：吸收。
    }
  }

  const dispatch: DispatchPort = {
    async dispatch(item, _seed) {
      const work = { prompt: item.label }
      const opts = item.model !== undefined ? { model: item.model, background: false } : { background: false }
      if (jisi !== undefined) {
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
        ...(item.model !== undefined ? { agentOptions: { model: item.model } } : {}),
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

  return { dispatch, interrupt }
}

/** ctx.hufu 服务面。 */
export interface HufuService {
  createCampaign(agent: Agent, config: CampaignConfig, items: WorkItem[]): HufuCampaign
}

export function createHufuService(ctx: Context, subagentProvider: string): HufuService {
  return {
    createCampaign(agent, config, items) {
      const holder: CampaignHolder = {}
      const ports = createHostPorts(ctx, agent, holder, subagentProvider)
      const campaign = new HufuCampaign(config, {
        now: () => Date.now(),
        ...ports,
      })
      holder.campaign = campaign
      for (const item of items) campaign.add(item)
      return campaign
    },
  }
}

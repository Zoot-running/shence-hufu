/**
 * 虎符 L1 集成探针：hufu_probe 工具跑一场迷你战役。
 * 2 个工作项（不同模型）并发派单，结算自动喂账本，返回战役摘要。
 * @module @shence/hufu-probe
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'shence-hufu-probe'
export const inject = ['tools', 'hufu']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'hufu_probe',
    description: 'Run a mini hufu campaign: dispatch two trivial work items to two different models in parallel and return the campaign summary.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hufu_probe requires a calling agent')
      const campaign = ctx.hufu.createCampaign(
        agent,
        { concurrency: 2, stallAfterMs: 120_000, heartbeatMs: 90_000 },
        [
          { id: 'p1', label: '请只回复一个单词：PONG', model: 'kimi-k2.6', priority: { tier: 0, score: 100 } },
          { id: 'p2', label: '请只回复一个单词：PONG', model: 'glm-4.5-air', priority: { tier: 0, score: 100 } },
        ],
      )
      await campaign.dispatchNext()
      await campaign.dispatchNext()
      // 等全部终态（最多 3 分钟）。
      const deadline = Date.now() + 180_000
      while (!campaign.isComplete() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const summary = campaign.summary()
      const details = campaign.ledger.views().map(v => `${v.item.id}#${v.seed}: ${v.state}`).join(' | ')
      return `summary=${JSON.stringify(summary)}\ndetails=${details}`
    },
  }))
}

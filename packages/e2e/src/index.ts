/**
 * 神策 L2 端到端合练探针：hufu_e2e 工具。
 * 4 工作项（tier 混排 + 混合模型）、并发 2、失败自动 requeue 重试（最多 2 轮）、
 * 中途序列化→恢复重放，最后返回摘要与账本细节。
 * @module @shence/hufu-e2e
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HufuCampaign } from '@shence/hufu'

export const name = 'shence-hufu-e2e'
export const inject = ['tools', 'hufu']

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'hufu_e2e',
    description: 'Run the shence L2 end-to-end exercise: a 4-item hufu campaign over the jisi channel with mixed models, automatic retry of failures, and a mid-run serialize/restore replay. Returns the summary and ledger details.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hufu_e2e requires a calling agent')
      const config = { concurrency: 2, stallAfterMs: 60_000, heartbeatMs: 90_000 }
      const items = [
        { id: 'w1', label: '请只回复一个单词：PONG', model: 'kimi-k2.6', priority: { tier: 1, score: 500 } },
        { id: 'w2', label: '请只回复一个单词：PONG', model: 'kimi-k2.6', priority: { tier: 0, score: 100 } },
        { id: 'w3', label: '请只回复一个单词：PONG', model: 'kimi-k2.6', priority: { tier: 0, score: 200 } },
        { id: 'w4', label: '请只回复一个单词：PONG', model: 'glm-4.5-air', priority: { tier: 2, score: 900 } },
      ]
      const campaign = ctx.hufu.createCampaign(agent, config, items)

      // 第一波：按槽位派单。
      while (campaign.freeSlots() > 0 && campaign.nextQueued().length > 0) {
        await campaign.dispatchNext()
      }
      // 中途恢复重放验证：序列化 → restore → 新实例（无操作端口）比对状态。
      const snapshot = campaign.serialize()
      const restored = HufuCampaign.restore(snapshot, {
        now: () => Date.now(),
        dispatch: { dispatch: async () => {} },
        interrupt: { interrupt: async () => {} },
      })
      const replayOk = restored.ledger.views().every(v => {
        const original = campaign.ledger.view(v.item.id)
        return original !== undefined && original.state === v.state
      })

      // 调度循环：槽位空闲即派排队项；失败项 requeue 重试（最多 2 轮）。
      const deadline = Date.now() + 240_000
      let retried = 0
      while (!campaign.isComplete() && Date.now() < deadline) {
        while (campaign.freeSlots() > 0 && campaign.nextQueued().length > 0) {
          await campaign.dispatchNext()
        }
        await sleep(1000)
        const failed = campaign.ledger.views().filter(v => v.state === 'failed')
        if (failed.length > 0 && retried < 2) {
          retried += 1
          for (const f of failed) {
            campaign.ledger.append(f.item.id, { type: 'requeue', at: Date.now(), seed: f.seed + 1, reason: 'e2e retry' })
          }
        }
      }

      const summary = campaign.summary()
      const details = campaign.ledger.views().map(v => `${v.item.id}#${v.seed}: ${v.state}`).join(' | ')
      return `summary=${JSON.stringify(summary)}\nreplayOk=${replayOk}\ndetails=${details}`
    },
  }))
}

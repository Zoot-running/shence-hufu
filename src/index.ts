/**
 * 虎符 DSH 插件入口：暴露 ctx.hufu 服务（创建战役 = 核心编排 + 宿主端口）
 * 与泛化调度工具（任何 agent 可用）：hufu_campaign_create / hufu_enqueue /
 * hufu_dispatch / hufu_collect / hufu_cancel / hufu_status / hufu_board。
 * 调度语义（入队、模型/思考强度按次指定、依赖、共享板、剪枝）归虎符，
 * 平台知识不在这里。
 * 派单执行面软依赖集思通道；无集思回退 DSH 原生 subagent。
 * @module @shence/hufu
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHufuService } from './binding.ts'
import type { HufuService } from './binding.ts'

export { HufuCampaign } from './campaign.ts'
export { HufuLedger } from './ledger.ts'
export { CampaignRegistry } from './registry.ts'
export { InvalidTransitionError, isActive, isTerminal, transition } from './state-machine.ts'
export type * from './types.ts'

export const name = 'shence-hufu'
export const inject = ['subagents', 'tools']

export interface Config {
  /** ctx.subagents 的 provider 名（默认 spawn）。 */
  provider?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'spawn'
  const service: HufuService = createHufuService(ctx, provider)
  ctx.provide('hufu', service)

  // ── 泛化调度工具（虎符 = 调度方；模型/强度选择在这里，任何 agent 可用） ──

  ctx.tools.register(defineTool({
    name: 'hufu_campaign_create',
    description:
      'Create a hufu campaign (parallel scheduling ledger) and return its id. Slots are unlimited by default — backpressure comes only from CPU/RAM/provider rate limits; work items dispatch as soon as they are ready (DAG dependencies satisfied) and a slot is free. Pass a stable id to make creation idempotent: a persisted snapshot under that id is restored (queued prompts intact, in-flight items reset for redispatch) — safe to call again after a crash/restart.',
    parameters: {
      id: { type: 'string', description: 'Stable campaign id (idempotent restore across restarts). Default: auto-generated.' },
      concurrency: { type: 'number', description: 'Campaign slots. Default 999 (no artificial threshold).' },
      budgetMinutes: { type: 'number', description: 'Campaign wall-clock budget (stops dispatch after). Default 330.' },
      stallMinutes: { type: 'number', description: 'Stall threshold for in-flight items. Default 40.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { id?: string; concurrency?: number; budgetMinutes?: number; stallMinutes?: number }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('hufu_campaign_create requires a calling agent')
      const { id } = service.createCampaign(agent, {
        concurrency: args.concurrency ?? 999,
        stallAfterMs: (args.stallMinutes ?? 40) * 60_000,
        heartbeatMs: 15 * 60_000,
        ...(args.budgetMinutes !== undefined ? { budgetMs: args.budgetMinutes * 60_000 } : {}),
      }, [], args.id !== undefined ? { id: args.id } : {})
      return `campaign created: ${id}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hufu_enqueue',
    description:
      'Enqueue one work item into a campaign. Scheduling semantics live here: per-item model and reasoning effort (you may switch to the model best suited for the task — nothing forces the default), DAG dependencies (runs after the listed item ids reach a terminal state), shared board group, and priority. The parent agent (or user-level policy) may lock models when desired.',
    parameters: {
      campaignId: { type: 'string', required: true },
      prompt: { type: 'string', required: true, description: 'The executor prompt (self-contained).' },
      model: { type: 'string', description: 'Per-item model override. Omit to use the platform default.' },
      effort: { type: 'string', description: 'Per-item reasoning effort (off/low/high/max; unsupported efforts are dropped).' },
      dependsOn: { type: 'array', description: 'Item ids to wait for (DAG).' },
      board: { type: 'string', description: 'Shared board group (workers coordinate through hufu_board).' },
      continuable: { type: 'boolean', description: 'Continuable executor: the same subagent keeps its context across rounds — prefer it for long or hard tasks, and for tasks already dispatched once without a useful result (respawn wastes the prior context). Report the outcome explicitly via hufu_report when you judge it settled, and steer it mid-way with hufu_continue.' },
      tier: { type: 'number', description: 'Priority tier (lower first).' },
      score: { type: 'number', description: 'Priority score (higher first within tier).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { campaignId: string; prompt: string; model?: string; effort?: string; dependsOn?: string[]; board?: string; continuable?: boolean; tier?: number; score?: number }) {
      const itemId = `item-${Date.now()}-${Math.floor(Math.random() * 10000)}`
      service.enqueue(args.campaignId, {
        id: itemId,
        label: args.prompt,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.effort !== undefined ? { reasoningEffort: args.effort } : {}),
        ...(args.dependsOn !== undefined && args.dependsOn.length > 0 ? { dependsOn: args.dependsOn } : {}),
        ...(args.board !== undefined ? { board: args.board } : {}),
        ...(args.continuable === true ? { continuable: true } : {}),
        ...(args.tier !== undefined || args.score !== undefined
          ? { priority: { tier: args.tier ?? 0, score: args.score ?? 0 } }
          : {}),
      })
      return `enqueued ${itemId}${args.model !== undefined ? ` (model=${args.model})` : ''}${args.effort !== undefined ? ` (effort=${args.effort})` : ''}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hufu_dispatch',
    description: 'Dispatch every ready queued item while slots are free. Call after enqueues and again whenever a slot frees — never wait for the slowest item.',
    parameters: { campaignId: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { campaignId: string }) {
      const count = await service.dispatch(args.campaignId)
      return `dispatched ${count} item(s)`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hufu_collect',
    description: 'Collect settled work items (done/failed/blocked) since the last collect; each item is returned once. Returns id/state/model/output-detail per item.',
    parameters: { campaignId: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { campaignId: string }) {
      const settled = service.collect(args.campaignId)
      if (settled.length === 0) return 'hufu_collect: nothing settled yet'
      return settled.map(s => `--- ${s.itemId} [${s.state}]${s.model !== undefined ? ` model=${s.model}` : ''}\n${(s.detail ?? '').slice(0, 6000)}`).join('\n\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hufu_cancel',
    description: 'Prune a queued/in-flight item (blocked terminal) — e.g. when a sibling already solved the goal.',
    parameters: {
      campaignId: { type: 'string', required: true },
      itemId: { type: 'string', required: true },
      reason: { type: 'string', description: 'Short reason.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { campaignId: string; itemId: string; reason?: string }) {
      service.cancel(args.campaignId, args.itemId, args.reason ?? 'cancelled')
      return `cancelled ${args.itemId}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hufu_report',
    description: 'Report your judgment for a work item (done/failed/blocked) — the settlement entry for continuable executors: when you see the child settle in your session, judge the outcome and record it here.',
    parameters: {
      campaignId: { type: 'string', required: true },
      itemId: { type: 'string', required: true },
      kind: { type: 'string', required: true, description: 'done | failed | blocked' },
      detail: { type: 'string', description: 'Outcome detail (logs into the ledger).' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { campaignId: string; itemId: string; kind: string; detail?: string }) {
      if (args.kind !== 'done' && args.kind !== 'failed' && args.kind !== 'blocked') {
        return 'hufu_report: kind must be done | failed | blocked'
      }
      service.report(args.campaignId, args.itemId, args.kind, args.detail)
      return `reported ${args.itemId} → ${args.kind}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hufu_continue',
    description: 'Send a follow-up message to a continuable executor (same child, native context preserved) — the grind-continuity primitive: instead of respawning from scratch, steer the existing worker with new findings or the next step.',
    parameters: {
      campaignId: { type: 'string', required: true },
      itemId: { type: 'string', required: true },
      message: { type: 'string', required: true, description: 'The follow-up steering message.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { campaignId: string; itemId: string; message: string }) {
      await service.continue(args.campaignId, args.itemId, args.message)
      return `message delivered to ${args.itemId}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hufu_status',
    description: 'Campaign ledger summary: open/queued/done/failed/blocked counts.',
    parameters: { campaignId: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { campaignId: string }) {
      return JSON.stringify(service.status(args.campaignId))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hufu_board',
    description: 'Shared board path for a group (parallel workers coordinate by reading/appending this file).',
    parameters: {
      campaignId: { type: 'string', required: true },
      group: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { campaignId: string; group: string }) {
      return service.boardPath(args.campaignId, args.group)
    },
  }))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hufu: import('./binding.ts').HufuService
  }
}

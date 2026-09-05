/**
 * 虎符 DSH 插件入口：暴露 ctx.hufu 服务（创建战役 = 核心编排 + 宿主端口）。
 * 派单执行面软依赖集思通道；无集思回退 DSH 原生 subagent。
 * @module @shence/hufu
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHufuService } from './binding.ts'

export { HufuCampaign } from './campaign.ts'
export { HufuLedger } from './ledger.ts'
export { InvalidTransitionError, isActive, isTerminal, transition } from './state-machine.ts'
export type * from './types.ts'

export const name = 'shence-hufu'
export const inject = ['subagents']

export interface Config {
  /** ctx.subagents 的 provider 名（默认 spawn）。 */
  provider?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'spawn'
  ctx.provide('hufu', createHufuService(ctx, provider))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hufu: import('./binding.ts').HufuService
  }
}

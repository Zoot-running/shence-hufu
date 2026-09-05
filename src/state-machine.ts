/**
 * 虎符状态机：work 状态 × 账本事件的纯转移函数（ADR-001）。
 * 非法转移抛错；superseded 吸收 terminal（重复报告去重由账本层实现）。
 * @module @shence/hufu/state-machine
 */

import type { LedgerEvent, WorkState } from './types.ts'

export class InvalidTransitionError extends Error {
  constructor(from: WorkState, event: LedgerEvent['type']) {
    super(`hufu: invalid transition ${from} -> ${event}`)
    this.name = 'InvalidTransitionError'
  }
}

/** 单步转移。 */
export function transition(state: WorkState, event: LedgerEvent): WorkState {
  switch (event.type) {
    case 'dispatch':
      if (state === 'queued') return 'dispatched'
      break
    case 'progress':
      if (state === 'dispatched' || state === 'help') return state
      break
    case 'help':
      if (state === 'dispatched') return 'help'
      break
    case 'stall':
      if (state === 'dispatched' || state === 'help') return 'stalled'
      break
    case 'supersede':
      if (state === 'stalled' || state === 'dispatched' || state === 'help') return 'superseded'
      break
    case 'terminal':
      if (state === 'dispatched' || state === 'help' || state === 'stalled') return event.kind
      // 旧 seed 迟报终态：保持 superseded（去重吸收）。
      if (state === 'superseded') return state
      break
    case 'requeue':
      if (state === 'stalled' || state === 'failed' || state === 'blocked' || state === 'superseded') return 'queued'
      break
    default:
      break
  }
  throw new InvalidTransitionError(state, event.type)
}

/** 状态是否为终态。 */
export function isTerminal(state: WorkState): boolean {
  return state === 'done' || state === 'failed' || state === 'blocked' || state === 'superseded'
}

/** 状态是否为活跃（占用槽位）。 */
export function isActive(state: WorkState): boolean {
  return state === 'dispatched' || state === 'help' || state === 'stalled'
}

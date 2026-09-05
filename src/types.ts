/**
 * 虎符核心类型（ADR-001 契约）。
 * 纯领域模型：工作项、槽位状态、账本事件、战役配置。
 * @module @shence/hufu/types
 */

/** 工作项终态。 */
export type WorkTerminal = 'done' | 'failed' | 'blocked'

/** 工作项生命周期状态。 */
export type WorkState =
  | 'queued'        // 等待派单
  | 'dispatched'    // 已派单（某 seed 执行中）
  | 'help'          // 已派单且请求了外部帮助（hint 等由平台侧处理，虎符只记录）
  | 'stalled'       // 超过 stall 阈值无进展
  | 'superseded'    // 旧 seed 已被新 seed 取代（终态，不可再转移）
  | WorkTerminal

/** 工作项静态描述。 */
export interface WorkItem {
  /** 稳定唯一标识。 */
  readonly id: string
  /** 人读标签（亦作为派单 prompt 正文；宿主绑定可定制渲染）。 */
  readonly label: string
  /** 派单排序提示：tier 升序、score 降序（缺省按加入顺序）。 */
  readonly priority?: { readonly tier: number; readonly score: number }
  /** 可选：按次指定模型（经集思通道时生效）。 */
  readonly model?: string
  /** 可选：按次指定思考强度（off/low/high/max 等，adapter 自有语义）。 */
  readonly reasoningEffort?: string
}

/** 工作项运行时视图（由账本事件折叠而来）。 */
export interface WorkView {
  readonly item: WorkItem
  readonly state: WorkState
  /** 当前 seed（重派次数；首次派单 = 1）。 */
  readonly seed: number
  /** 最近一次派单时间戳。 */
  readonly dispatchedAt?: number
  /** 最近一次进展时间戳（progress 事件）。 */
  readonly lastProgressAt?: number
  /** stall 后是否已触发重派。 */
  readonly redispatchRequested: boolean
  /** 当前 seed 终态报告的详情（求解输出等，宿主绑定写入）。 */
  readonly terminalDetail?: string
}

/** 账本事件（追加日志，恢复 = 重放）。 */
export type LedgerEvent =
  | { readonly type: 'dispatch'; readonly at: number; readonly seed: number }
  | { readonly type: 'progress'; readonly at: number; readonly seed: number; readonly note?: string }
  | { readonly type: 'help'; readonly at: number; readonly seed: number; readonly reason: string }
  | { readonly type: 'stall'; readonly at: number; readonly seed: number }
  | { readonly type: 'supersede'; readonly at: number; readonly seed: number; readonly reason: string }
  | { readonly type: 'terminal'; readonly at: number; readonly seed: number; readonly kind: WorkTerminal; readonly detail?: string }
  | { readonly type: 'requeue'; readonly at: number; readonly seed: number; readonly reason: string }

/** 战役配置。 */
export interface CampaignConfig {
  /** 并发槽位上限（用户显式上限优先，其次自动推导）。 */
  concurrency: number
  /** 无进展判定为 stall 的时长（毫秒）。 */
  stallAfterMs: number
  /** 心跳必退出间隔（毫秒）：保活后台任务每轮必须在该时限内结算。 */
  heartbeatMs: number
  /** 可选战役预算（毫秒）；到期后 remaining 视为停止派单。 */
  budgetMs?: number
}

/** 派单端口：宿主把工作派给求解代理（经集思通道或 DSH 原生 subagent）。 */
export interface DispatchPort {
  dispatch(item: WorkItem, seed: number): Promise<void>
}

/** 重派前中断旧 seed 的端口（宿主实现：interrupt_agent 等）。 */
export interface InterruptPort {
  interrupt(item: WorkItem, seed: number): Promise<void>
}

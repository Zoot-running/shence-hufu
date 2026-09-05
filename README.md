# 虎符（shence-hufu）—— 并行调度

神策（SHENCE）项目群 P1。DSH 插件：给 DSH 会话提供可靠的子代理并行工作管理。

## 功能

- **战役（campaign）**：工作项清单 + 并发上限 N + 预算 + 完成口径的有界调度单元；
- **槽位状态机**：dispatched → probing → 求助 → stalled → superseded → terminal（完成/失败/阻塞）；
- **工作项账本**：终态处理、重复报告去重、调度级崩溃恢复（账本回放）；
- **stall 重派**：seed 多样性；
- **心跳保活**：harness 后台任务必退出模式，结算即唤醒；
- 并发上限：`N = 用户显式上限 ?? 自动推导（本地性能 + 模型 API 限制）`。

## 边界

- 不感知平台概念（hint 账本、平台 API 在 shence-yebushou@ctf）；
- 派单优先经 shence-jisi 通道（按次指定模型）；**无 jisi 时回退 DSH 原生 subagent 调度**（软依赖）。

## 关联

- 依赖（软）：[shence-jisi](https://github.com/Zoot-running/shence-jisi) 派单通道
- 被监督：[shence-jintuo](https://github.com/Zoot-running/shence-jintuo)（进程级恢复；本仓负责调度级恢复）
- 文档：[shence-docs](https://github.com/Zoot-running/shence-docs)

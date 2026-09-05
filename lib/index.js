// src/binding.ts
import { settleRun } from "@deepseek-ai/dsh-subagent";

// src/state-machine.ts
var InvalidTransitionError = class extends Error {
  constructor(from, event) {
    super(`hufu: invalid transition ${from} -> ${event}`);
    this.name = "InvalidTransitionError";
  }
};
function transition(state, event) {
  switch (event.type) {
    case "dispatch":
      if (state === "queued") return "dispatched";
      break;
    case "progress":
      if (state === "dispatched" || state === "help") return state;
      break;
    case "help":
      if (state === "dispatched") return "help";
      break;
    case "stall":
      if (state === "dispatched" || state === "help") return "stalled";
      break;
    case "supersede":
      if (state === "stalled" || state === "dispatched" || state === "help") return "superseded";
      break;
    case "terminal":
      if (state === "dispatched" || state === "help" || state === "stalled") return event.kind;
      if (state === "superseded") return state;
      break;
    case "requeue":
      if (state === "stalled" || state === "failed" || state === "blocked" || state === "superseded") return "queued";
      break;
    default:
      break;
  }
  throw new InvalidTransitionError(state, event.type);
}
function isTerminal(state) {
  return state === "done" || state === "failed" || state === "blocked" || state === "superseded";
}
function isActive(state) {
  return state === "dispatched" || state === "help" || state === "stalled";
}

// src/ledger.ts
var HufuLedger = class _HufuLedger {
  /** itemId → 有序事件列表。 */
  events = /* @__PURE__ */ new Map();
  /** itemId → WorkItem（注册时快照）。 */
  items = /* @__PURE__ */ new Map();
  /** 注册工作项（幂等）。 */
  register(item) {
    if (this.items.has(item.id)) return;
    this.items.set(item.id, item);
    this.events.set(item.id, []);
  }
  /** 追记事件：校验转移并记录；非法转移抛 InvalidTransitionError。 */
  append(itemId, event) {
    const list = this.events.get(itemId);
    if (list === void 0) throw new Error(`hufu: unknown work item "${itemId}"`);
    const current = this.foldEvents(list);
    if (current === void 0) {
      if (event.type === "dispatch" || event.type === "requeue") {
        list.push(event);
        return;
      }
      throw new Error(`hufu: first event for "${itemId}" must be dispatch/requeue, got ${event.type}`);
    }
    if (event.type === "dispatch" && event.seed > this.currentSeed(list) || event.type === "requeue") {
      list.push(event);
      return;
    }
    transition(current, event);
    list.push(event);
  }
  /** 当前最大 seed。 */
  currentSeed(list) {
    let seed = 0;
    for (const event of list) {
      if (event.type === "dispatch" && event.seed > seed) seed = event.seed;
    }
    return seed;
  }
  /** 显式事件折叠（首事件 dispatch→dispatched；requeue→queued；新 seed 重开；旧 seed 事件吸收）。 */
  foldEvents(list) {
    if (list.length === 0) return void 0;
    let state = list[0].type === "dispatch" ? "dispatched" : "queued";
    let seed = list[0].seed;
    for (let i = 1; i < list.length; i++) {
      const event = list[i];
      if (event.type === "dispatch" && event.seed > seed) {
        seed = event.seed;
        state = "dispatched";
        continue;
      }
      if (event.type === "requeue") {
        seed = event.seed;
        state = "queued";
        continue;
      }
      if (event.seed !== seed) continue;
      state = transition(state, event);
    }
    return state;
  }
  /** 工作项当前视图。 */
  view(itemId) {
    const item = this.items.get(itemId);
    const list = this.events.get(itemId);
    if (item === void 0 || list === void 0) return void 0;
    if (list.length === 0) {
      return { item, state: "queued", seed: 1, redispatchRequested: false };
    }
    const state = this.foldEvents(list);
    if (state === void 0) return void 0;
    const facts = {};
    let seed = 1;
    let redispatchRequested = false;
    for (const event of list) {
      if (event.type === "dispatch") {
        seed = event.seed;
        facts.dispatchedAt = event.at;
      } else if (event.type === "progress") {
        facts.lastProgressAt = event.at;
      } else if (event.type === "supersede") {
        redispatchRequested = true;
      } else if (event.type === "requeue") {
        seed = event.seed;
        redispatchRequested = false;
      }
    }
    return {
      item,
      state,
      seed,
      dispatchedAt: facts.dispatchedAt,
      lastProgressAt: facts.lastProgressAt,
      redispatchRequested
    };
  }
  /** 全部视图（注册顺序）。 */
  views() {
    return [...this.items.keys()].map((id) => this.view(id)).filter((v) => v !== void 0);
  }
  /** 活跃项（占用槽位）。 */
  open() {
    return this.views().filter((v) => v.state === "dispatched" || v.state === "help" || v.state === "stalled");
  }
  /** 排队项（可派单）。 */
  queued() {
    return this.views().filter((v) => v.state === "queued");
  }
  /** 终态项。 */
  terminal() {
    return this.views().filter((v) => isTerminal(v.state));
  }
  /** 全部事件（序列化/恢复用）。 */
  dump() {
    return [...this.events.entries()].map(([itemId, events]) => ({ itemId, events: [...events] }));
  }
  /** 由 dump 恢复（崩溃恢复 = 账本重放）。 */
  static restore(items, dump) {
    const ledger = new _HufuLedger();
    for (const item of items) ledger.register(item);
    for (const { itemId, events } of dump) {
      ledger.register({ id: itemId, label: itemId });
      for (const event of events) ledger.append(itemId, event);
    }
    return ledger;
  }
};

// src/campaign.ts
function byPriority(a, b) {
  const pa = a.item.priority;
  const pb = b.item.priority;
  if (pa !== void 0 && pb !== void 0) {
    if (pa.tier !== pb.tier) return pa.tier - pb.tier;
    if (pa.score !== pb.score) return pb.score - pa.score;
  }
  if (pa !== void 0) return -1;
  if (pb !== void 0) return 1;
  return 0;
}
var HufuCampaign = class _HufuCampaign {
  constructor(config, ports) {
    this.config = config;
    this.ports = ports;
  }
  ledger = new HufuLedger();
  /** 注册工作项（幂等）。 */
  add(item) {
    this.ledger.register(item);
  }
  /** 可派单的排队项（按优先级排序）。 */
  nextQueued() {
    return this.ledger.queued().sort(byPriority);
  }
  /** 活跃项（占用槽位）。 */
  open() {
    return this.ledger.open();
  }
  /** 剩余可派单槽位。 */
  freeSlots() {
    const budgetExpired = this.config.budgetMs !== void 0 && this.ports.now() - (this.startedAt() ?? this.ports.now()) > this.config.budgetMs;
    if (budgetExpired) return 0;
    return Math.max(0, this.config.concurrency - this.open().length);
  }
  /** 战役首个事件时间戳（预算起点）。 */
  startedAt() {
    for (const view of this.ledger.views()) {
      if (view.dispatchedAt !== void 0) return view.dispatchedAt;
    }
    return void 0;
  }
  /** 派单一个排队项（返回视图；无槽位/无排队返回 undefined）。 */
  async dispatchNext() {
    if (this.freeSlots() <= 0) return void 0;
    const next = this.nextQueued()[0];
    if (next === void 0) return void 0;
    const at = this.ports.now();
    const seed = next.seed;
    this.ledger.append(next.item.id, { type: "dispatch", at, seed });
    await this.ports.dispatch.dispatch(next.item, seed);
    return this.ledger.view(next.item.id);
  }
  /** 工作项进展（宿主轮询 progress.log 等）。 */
  progress(itemId, note) {
    const view = this.ledger.view(itemId);
    if (view === void 0) throw new Error(`hufu: unknown work item "${itemId}"`);
    this.ledger.append(itemId, { type: "progress", at: this.ports.now(), seed: view.seed, note });
  }
  /** 工作项请求外部帮助（hint 等在平台侧执行；虎符只记录）。 */
  help(itemId, reason) {
    const view = this.ledger.view(itemId);
    if (view === void 0) throw new Error(`hufu: unknown work item "${itemId}"`);
    this.ledger.append(itemId, { type: "help", at: this.ports.now(), seed: view.seed, reason });
  }
  /** 终态报告（子代理完成通知）。superseded 旧 seed 的迟到报告被吸收。 */
  report(itemId, kind, detail) {
    const view = this.ledger.view(itemId);
    if (view === void 0) throw new Error(`hufu: unknown work item "${itemId}"`);
    if (view.state === "queued") {
      throw new InvalidTransitionError("queued", "terminal");
    }
    if (isTerminal(view.state)) {
      if (view.state === "superseded") return;
      return;
    }
    this.ledger.append(itemId, { type: "terminal", at: this.ports.now(), seed: view.seed, kind, detail });
  }
  /**
   * stall 检测：超过 stallAfterMs 无进展 → 标记 stall；
   * 若 redispatchRequested 为假 → supersede + requeue（seed+1），并中断旧 seed。
   */
  async stallCheck() {
    const now = this.ports.now();
    const stalledIds = [];
    for (const view of this.ledger.open()) {
      if (view.state !== "dispatched" && view.state !== "help") continue;
      const last = view.lastProgressAt ?? view.dispatchedAt;
      if (last === void 0 || now - last < this.config.stallAfterMs) continue;
      this.ledger.append(view.item.id, { type: "stall", at: now, seed: view.seed });
      if (!view.redispatchRequested) {
        await this.ports.interrupt.interrupt(view.item, view.seed);
        this.ledger.append(view.item.id, {
          type: "supersede",
          at: now,
          seed: view.seed,
          reason: `stall after ${this.config.stallAfterMs}ms without progress`
        });
        this.ledger.append(view.item.id, { type: "requeue", at: now, seed: view.seed + 1, reason: "redispatch with fresh seed" });
        stalledIds.push(view.item.id);
      }
    }
    return stalledIds;
  }
  /** 心跳间隔（保活后台任务必须在该时限内结算并续挂）。 */
  heartbeatMs() {
    return this.config.heartbeatMs;
  }
  /** 完成判定：预算耗尽或全部工作项终态。 */
  isComplete() {
    if (this.config.budgetMs !== void 0 && this.startedAt() !== void 0 && this.ports.now() - this.startedAt() > this.config.budgetMs) return true;
    const views = this.ledger.views();
    return views.length > 0 && views.every((v) => isTerminal(v.state));
  }
  /** 进度快照。 */
  summary() {
    const views = this.ledger.views();
    const count = (fn) => views.filter(fn).length;
    return {
      total: views.length,
      open: count((v) => isActive(v.state)),
      done: count((v) => v.state === "done"),
      failed: count((v) => v.state === "failed"),
      blocked: count((v) => v.state === "blocked"),
      superseded: count((v) => v.state === "superseded"),
      queued: count((v) => v.state === "queued")
    };
  }
  /** 序列化（崩溃恢复 = 账本重放）。 */
  serialize() {
    return {
      config: this.config,
      items: this.ledger.views().map((v) => v.item),
      dump: this.ledger.dump()
    };
  }
  /** 恢复（重放账本）。 */
  static restore(data, ports) {
    const campaign = new _HufuCampaign(data.config, ports);
    for (const item of data.items) campaign.ledger.register(item);
    for (const { itemId, events } of data.dump) {
      for (const event of events) campaign.ledger.append(itemId, event);
    }
    return campaign;
  }
};

// src/binding.ts
function textOfBlocks(output) {
  if (output === void 0) return "";
  return output.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("");
}
function createHostPorts(ctx, agent, holder, subagentProvider) {
  const jisi = ctx.get?.("jisi");
  const feed = (item, report) => {
    const campaign = holder.campaign;
    if (campaign === void 0) return;
    const kind = report.status === "completed" ? "done" : "failed";
    try {
      campaign.report(item.id, kind, report.text.slice(0, 200));
    } catch {
    }
  };
  const dispatch = {
    async dispatch(item, _seed) {
      const work = { prompt: item.label };
      const opts = item.model !== void 0 ? { model: item.model, background: false } : { background: false };
      if (jisi !== void 0) {
        const result = jisi.delegate(agent, work, opts);
        void result.report.then((report) => feed(item, report));
        return;
      }
      const run = ctx.subagents.start(subagentProvider, {
        label: `hufu-${item.id}`,
        prompt: [{ type: "text", text: item.label }],
        parent: agent,
        signal: new AbortController().signal,
        ...item.model !== void 0 ? { agentOptions: { model: item.model } } : {}
      });
      void run.then(async (r) => {
        const result = await r.result;
        void settleRun(r);
        feed(item, {
          status: result.stopReason === "completed" ? "completed" : "failed",
          text: textOfBlocks(result.output)
        });
      });
    }
  };
  const interrupt = {
    async interrupt(item, seed) {
      const logger = ctx.logger;
      if (logger !== void 0) logger("hufu").info(`interrupt requested for ${item.id}#${seed} (no-op in v1 binding)`);
    }
  };
  return { dispatch, interrupt };
}
function createHufuService(ctx, subagentProvider) {
  return {
    createCampaign(agent, config, items) {
      const holder = {};
      const ports = createHostPorts(ctx, agent, holder, subagentProvider);
      const campaign = new HufuCampaign(config, {
        now: () => Date.now(),
        ...ports
      });
      holder.campaign = campaign;
      for (const item of items) campaign.add(item);
      return campaign;
    }
  };
}

// src/index.ts
var name = "shence-hufu";
var inject = ["subagents"];
function apply(ctx, config = {}) {
  const provider = config.provider ?? "spawn";
  ctx.provide("hufu", createHufuService(ctx, provider));
}
export {
  HufuCampaign,
  HufuLedger,
  InvalidTransitionError,
  apply,
  inject,
  isActive,
  isTerminal,
  name,
  transition
};

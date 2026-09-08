// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/binding.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    case "cancel":
      if (state === "queued") return "blocked";
      if (state === "dispatched" || state === "help" || state === "stalled") return "blocked";
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
      if (event.type === "dispatch" || event.type === "requeue" || event.type === "cancel") {
        list.push(event);
        return;
      }
      throw new Error(`hufu: first event for "${itemId}" must be dispatch/requeue/cancel, got ${event.type}`);
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
  /** 显式事件折叠（首事件 dispatch→dispatched；cancel→blocked；requeue→queued；新 seed 重开；旧 seed 事件吸收）。 */
  foldEvents(list) {
    if (list.length === 0) return void 0;
    let state = list[0].type === "dispatch" ? "dispatched" : list[0].type === "cancel" ? "blocked" : "queued";
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
    let terminalDetail;
    for (const event of list) {
      if (event.type === "dispatch") {
        seed = event.seed;
        facts.dispatchedAt = event.at;
        terminalDetail = void 0;
      } else if (event.type === "progress") {
        facts.lastProgressAt = event.at;
      } else if (event.type === "supersede") {
        redispatchRequested = true;
      } else if (event.type === "requeue") {
        seed = event.seed;
        redispatchRequested = false;
        terminalDetail = void 0;
      } else if (event.type === "terminal" && event.seed === seed) {
        terminalDetail = event.detail;
      }
    }
    return {
      item,
      state,
      seed,
      dispatchedAt: facts.dispatchedAt,
      lastProgressAt: facts.lastProgressAt,
      redispatchRequested,
      terminalDetail
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
  /** 可派单的排队项：依赖全部终态（图状事务就绪）后按优先级排序。 */
  nextQueued() {
    return this.ledger.queued().filter((v) => this.dependenciesSatisfied(v)).sort(byPriority);
  }
  /** 依赖判定：未知依赖视为已满足（防御死锁），否则必须全部终态。 */
  dependenciesSatisfied(view) {
    const depends = view.item.dependsOn ?? [];
    return depends.every((id) => {
      const dep = this.ledger.view(id);
      return dep === void 0 || isTerminal(dep.state);
    });
  }
  /** 共享板路径（并行工人互相联系的泛化信道；宿主绑定实现）。 */
  boardPath(group) {
    return this.ports.board.pathOf(group);
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
  /** 剪枝：撤销排队/在途项（同题已破、思路废弃等）→ blocked 终态，释放槽位与队列。 */
  cancel(itemId, reason) {
    const view = this.ledger.view(itemId);
    if (view === void 0) throw new Error(`hufu: unknown work item "${itemId}"`);
    if (isTerminal(view.state)) return;
    this.ledger.append(itemId, { type: "cancel", at: this.ports.now(), seed: view.seed, reason });
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
  /** 恢复（重放账本）；resetOpen=true 时把非终态在途项重置回队列（进程重启后执行者已死）。 */
  static restore(data, ports, opts = {}) {
    const campaign = new _HufuCampaign(data.config, ports);
    for (const item of data.items) campaign.ledger.register(item);
    for (const { itemId, events } of data.dump) {
      for (const event of events) campaign.ledger.append(itemId, event);
    }
    if (opts.resetOpen === true) {
      const now = ports.now();
      for (const view of campaign.ledger.views()) {
        if (isTerminal(view.state) || view.state === "queued") continue;
        campaign.ledger.append(view.item.id, {
          type: "supersede",
          at: now,
          seed: view.seed,
          reason: "restored after process restart (in-flight executor lost)"
        });
        campaign.ledger.append(view.item.id, {
          type: "requeue",
          at: now,
          seed: view.seed + 1,
          reason: "requeue after restore"
        });
      }
    }
    return campaign;
  }
};

// src/registry.ts
var CampaignRegistry = class {
  campaigns = /* @__PURE__ */ new Map();
  delivered = /* @__PURE__ */ new Map();
  seq = 0;
  register(campaign, id) {
    const finalId = id ?? `campaign-${++this.seq}`;
    if (this.campaigns.has(finalId)) throw new Error(`hufu: campaign id "${finalId}" already registered`);
    this.campaigns.set(finalId, campaign);
    this.delivered.set(finalId, /* @__PURE__ */ new Set());
    return finalId;
  }
  get(id) {
    return this.campaigns.get(id);
  }
  ids() {
    return [...this.campaigns.keys()];
  }
  /** collect 交付去重：首次返回 true 并标记；已交付返回 false。 */
  markDelivered(campaignId, itemId) {
    const set = this.delivered.get(campaignId);
    if (set === void 0) return false;
    if (set.has(itemId)) return false;
    set.add(itemId);
    return true;
  }
};

// src/binding.ts
function textOfBlocks(output) {
  if (output === void 0) return "";
  return output.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("");
}
function createHostPorts(ctx, agent, holder, subagentProvider, jisi) {
  const continuables = /* @__PURE__ */ new Map();
  const feed = (item, report) => {
    const campaign = holder.campaign;
    if (campaign === void 0) return;
    const kind = report.status === "completed" ? "done" : "failed";
    try {
      campaign.report(item.id, kind, report.text.slice(0, 65536));
      holder.mutated?.();
    } catch {
    }
  };
  const dispatch = {
    async dispatch(item, _seed) {
      const work = { prompt: item.label };
      const opts = {
        background: false,
        ...item.model !== void 0 ? { model: item.model } : {},
        ...item.reasoningEffort !== void 0 ? { reasoningEffort: item.reasoningEffort } : {}
      };
      if (jisi !== void 0) {
        if (item.continuable === true) {
          const result2 = jisi.delegate(agent, work, { ...opts, background: true });
          continuables.set(item.id, { childId: result2.ref.id, parent: agent });
          void result2.report.then((report) => {
            if (report.status === "failed") feed(item, report);
          });
          return;
        }
        const result = jisi.delegate(agent, work, opts);
        void result.report.then((report) => feed(item, report));
        return;
      }
      const run = ctx.subagents.start(subagentProvider, {
        label: `hufu-${item.id}`,
        prompt: [{ type: "text", text: item.label }],
        parent: agent,
        signal: new AbortController().signal,
        ...item.model !== void 0 || item.reasoningEffort !== void 0 ? {
          agentOptions: {
            ...item.model !== void 0 ? { model: item.model } : {},
            ...item.reasoningEffort !== void 0 ? { reasoningEffort: item.reasoningEffort } : {}
          }
        } : {}
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
  const board = {
    pathOf(group) {
      const safe = group.replace(/[^A-Za-z0-9._-]/g, "_");
      const dir = join(process.cwd(), "boards", safe);
      mkdirSync(dir, { recursive: true });
      return join(dir, "FINDINGS.md");
    }
  };
  return { dispatch, interrupt, board, continuables };
}
function createHufuService(ctx, subagentProvider) {
  const jisi = ctx.get?.("jisi");
  const registry = new CampaignRegistry();
  const continuablesByCampaign = /* @__PURE__ */ new Map();
  const require2 = (id) => {
    const campaign = registry.get(id);
    if (campaign === void 0) throw new Error(`hufu: unknown campaign "${id}"`);
    return campaign;
  };
  const snapshotRoot = join(process.env.DSH_HOME ?? ".", "storages", "hufu-campaigns");
  const snapshotPath = (id) => join(snapshotRoot, `${id}.json`);
  const persist = (id, campaign) => {
    try {
      mkdirSync(snapshotRoot, { recursive: true });
      const tmp = `${snapshotPath(id)}.tmp`;
      writeFileSync(tmp, JSON.stringify(campaign.serialize()));
      renameSync(tmp, snapshotPath(id));
    } catch {
    }
  };
  return {
    createCampaign(agent, config, items, opts = {}) {
      const holder = {};
      const ports = createHostPorts(ctx, agent, holder, subagentProvider, jisi);
      let campaign;
      let restored = false;
      const id = opts.id ?? `campaign-${Date.now()}`;
      if (opts.id !== void 0 && existsSync(snapshotPath(opts.id))) {
        try {
          campaign = HufuCampaign.restore(JSON.parse(readFileSync(snapshotPath(opts.id), "utf8")), {
            now: () => Date.now(),
            ...ports
          }, { resetOpen: true });
          restored = true;
        } catch {
          campaign = new HufuCampaign(config, { now: () => Date.now(), ...ports });
        }
      } else {
        campaign = new HufuCampaign(config, { now: () => Date.now(), ...ports });
      }
      holder.campaign = campaign;
      if (!restored) {
        for (const item of items) campaign.add(item);
      }
      registry.register(campaign, id);
      holder.mutated = () => persist(id, campaign);
      continuablesByCampaign.set(id, ports.continuables);
      persist(id, campaign);
      return { id, campaign };
    },
    get: (id) => registry.get(id),
    ids: () => registry.ids(),
    enqueue(id, item) {
      require2(id).add(item);
      persist(id, require2(id));
      return item.id;
    },
    async dispatch(id) {
      const campaign = require2(id);
      let count = 0;
      while (campaign.freeSlots() > 0 && campaign.nextQueued().length > 0) {
        await campaign.dispatchNext();
        count += 1;
      }
      persist(id, campaign);
      return count;
    },
    collect(id) {
      const campaign = require2(id);
      const out = [];
      for (const view of campaign.ledger.views()) {
        if (view.state !== "done" && view.state !== "failed" && view.state !== "blocked") continue;
        if (!registry.markDelivered(id, view.item.id)) continue;
        out.push({
          itemId: view.item.id,
          state: view.state,
          model: view.item.model,
          detail: view.terminalDetail
        });
      }
      return out;
    },
    cancel(id, itemId, reason) {
      require2(id).cancel(itemId, reason);
      persist(id, require2(id));
    },
    report(id, itemId, kind, detail) {
      require2(id).report(itemId, kind, detail);
      persist(id, require2(id));
    },
    async continue(id, itemId, message) {
      const entry = continuablesByCampaign.get(id)?.get(itemId);
      if (entry === void 0) throw new Error(`hufu: no continuable child for "${itemId}"`);
      if (jisi === void 0) throw new Error("hufu: jisi channel required for continuable children");
      await jisi.continue(entry.parent, entry.childId, message);
    },
    status(id) {
      const views = require2(id).ledger.views();
      const count = (fn) => views.filter((v) => fn(v.state)).length;
      return {
        open: count((s) => s === "dispatched" || s === "help" || s === "stalled"),
        queued: count((s) => s === "queued"),
        done: count((s) => s === "done"),
        failed: count((s) => s === "failed"),
        blocked: count((s) => s === "blocked")
      };
    },
    boardPath: (id, group) => require2(id).boardPath(group),
    finish(id) {
      const campaign = require2(id);
      persist(id, campaign);
      try {
        mkdirSync(join(snapshotRoot, "archive"), { recursive: true });
        renameSync(snapshotPath(id), join(snapshotRoot, "archive", `${id}.json`));
      } catch {
      }
    }
  };
}

// src/index.ts
var name = "shence-hufu";
var inject = ["subagents", "tools"];
function apply(ctx, config = {}) {
  const provider = config.provider ?? "spawn";
  const service = createHufuService(ctx, provider);
  ctx.provide("hufu", service);
  ctx.tools.register(defineTool({
    name: "hufu_campaign_create",
    description: "Create a hufu campaign (parallel scheduling ledger) and return its id. Slots are unlimited by default \u2014 backpressure comes only from CPU/RAM/provider rate limits; work items dispatch as soon as they are ready (DAG dependencies satisfied) and a slot is free. Pass a stable id to make creation idempotent: a persisted snapshot under that id is restored (queued prompts intact, in-flight items reset for redispatch) \u2014 safe to call again after a crash/restart.",
    parameters: {
      id: { type: "string", description: "Stable campaign id (idempotent restore across restarts). Default: auto-generated." },
      concurrency: { type: "number", description: "Campaign slots. Default 999 (no artificial threshold)." },
      budgetMinutes: { type: "number", description: "Campaign wall-clock budget (stops dispatch after). Default 330." },
      stallMinutes: { type: "number", description: "Stall threshold for in-flight items. Default 40." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("hufu_campaign_create requires a calling agent");
      const { id } = service.createCampaign(agent, {
        concurrency: args.concurrency ?? 999,
        stallAfterMs: (args.stallMinutes ?? 40) * 6e4,
        heartbeatMs: 15 * 6e4,
        ...args.budgetMinutes !== void 0 ? { budgetMs: args.budgetMinutes * 6e4 } : {}
      }, [], args.id !== void 0 ? { id: args.id } : {});
      return `campaign created: ${id}`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "hufu_enqueue",
    description: "Enqueue one work item into a campaign. Scheduling semantics live here: per-item model and reasoning effort (you may switch to the model best suited for the task \u2014 nothing forces the default), DAG dependencies (runs after the listed item ids reach a terminal state), shared board group, and priority. The parent agent (or user-level policy) may lock models when desired.",
    parameters: {
      campaignId: { type: "string", required: true },
      prompt: { type: "string", required: true, description: "The executor prompt (self-contained)." },
      model: { type: "string", description: "Per-item model override. Omit to use the platform default." },
      effort: { type: "string", description: "Per-item reasoning effort (off/low/high/max; unsupported efforts are dropped)." },
      dependsOn: { type: "array", description: "Item ids to wait for (DAG)." },
      board: { type: "string", description: "Shared board group (workers coordinate through hufu_board)." },
      continuable: { type: "boolean", description: "Continuable executor: the same subagent keeps its context across rounds \u2014 prefer it for long or hard tasks, and for tasks already dispatched once without a useful result (respawn wastes the prior context). Report the outcome explicitly via hufu_report when you judge it settled, and steer it mid-way with hufu_continue." },
      tier: { type: "number", description: "Priority tier (lower first)." },
      score: { type: "number", description: "Priority score (higher first within tier)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const itemId = `item-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
      service.enqueue(args.campaignId, {
        id: itemId,
        label: args.prompt,
        ...args.model !== void 0 ? { model: args.model } : {},
        ...args.effort !== void 0 ? { reasoningEffort: args.effort } : {},
        ...args.dependsOn !== void 0 && args.dependsOn.length > 0 ? { dependsOn: args.dependsOn } : {},
        ...args.board !== void 0 ? { board: args.board } : {},
        ...args.continuable === true ? { continuable: true } : {},
        ...args.tier !== void 0 || args.score !== void 0 ? { priority: { tier: args.tier ?? 0, score: args.score ?? 0 } } : {}
      });
      return `enqueued ${itemId}${args.model !== void 0 ? ` (model=${args.model})` : ""}${args.effort !== void 0 ? ` (effort=${args.effort})` : ""}`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "hufu_dispatch",
    description: "Dispatch every ready queued item while slots are free. Call after enqueues and again whenever a slot frees \u2014 never wait for the slowest item.",
    parameters: { campaignId: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const count = await service.dispatch(args.campaignId);
      return `dispatched ${count} item(s)`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "hufu_collect",
    description: "Collect settled work items (done/failed/blocked) since the last collect; each item is returned once. Returns id/state/model/output-detail per item.",
    parameters: { campaignId: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      const settled = service.collect(args.campaignId);
      if (settled.length === 0) return "hufu_collect: nothing settled yet";
      return settled.map((s) => `--- ${s.itemId} [${s.state}]${s.model !== void 0 ? ` model=${s.model}` : ""}
${(s.detail ?? "").slice(0, 6e3)}`).join("\n\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "hufu_cancel",
    description: "Prune a queued/in-flight item (blocked terminal) \u2014 e.g. when a sibling already solved the goal.",
    parameters: {
      campaignId: { type: "string", required: true },
      itemId: { type: "string", required: true },
      reason: { type: "string", description: "Short reason." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      service.cancel(args.campaignId, args.itemId, args.reason ?? "cancelled");
      return `cancelled ${args.itemId}`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "hufu_report",
    description: "Report your judgment for a work item (done/failed/blocked) \u2014 the settlement entry for continuable executors: when you see the child settle in your session, judge the outcome and record it here.",
    parameters: {
      campaignId: { type: "string", required: true },
      itemId: { type: "string", required: true },
      kind: { type: "string", required: true, description: "done | failed | blocked" },
      detail: { type: "string", description: "Outcome detail (logs into the ledger)." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.kind !== "done" && args.kind !== "failed" && args.kind !== "blocked") {
        return "hufu_report: kind must be done | failed | blocked";
      }
      service.report(args.campaignId, args.itemId, args.kind, args.detail);
      return `reported ${args.itemId} \u2192 ${args.kind}`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "hufu_continue",
    description: "Send a follow-up message to a continuable executor (same child, native context preserved) \u2014 the grind-continuity primitive: instead of respawning from scratch, steer the existing worker with new findings or the next step.",
    parameters: {
      campaignId: { type: "string", required: true },
      itemId: { type: "string", required: true },
      message: { type: "string", required: true, description: "The follow-up steering message." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      await service.continue(args.campaignId, args.itemId, args.message);
      return `message delivered to ${args.itemId}`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "hufu_status",
    description: "Campaign ledger summary: open/queued/done/failed/blocked counts.",
    parameters: { campaignId: { type: "string", required: true } },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      return JSON.stringify(service.status(args.campaignId));
    }
  }));
  ctx.tools.register(defineTool({
    name: "hufu_board",
    description: "Shared board path for a group (parallel workers coordinate by reading/appending this file).",
    parameters: {
      campaignId: { type: "string", required: true },
      group: { type: "string", required: true }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      return service.boardPath(args.campaignId, args.group);
    }
  }));
}
export {
  CampaignRegistry,
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

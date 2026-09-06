// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import { HufuCampaign } from "@shence/hufu";
var name = "shence-hufu-e2e";
var inject = ["tools", "hufu"];
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "hufu_e2e",
    description: "Run the shence L2 end-to-end exercise: a 4-item hufu campaign over the jisi channel with mixed models, automatic retry of failures, and a mid-run serialize/restore replay. Returns the summary and ledger details.",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("hufu_e2e requires a calling agent");
      const config = { concurrency: 2, stallAfterMs: 6e4, heartbeatMs: 9e4 };
      const items = [
        { id: "w1", label: "\u8BF7\u53EA\u56DE\u590D\u4E00\u4E2A\u5355\u8BCD\uFF1APONG", model: "kimi-k2.6", priority: { tier: 1, score: 500 } },
        { id: "w2", label: "\u8BF7\u53EA\u56DE\u590D\u4E00\u4E2A\u5355\u8BCD\uFF1APONG", model: "kimi-k2.6", priority: { tier: 0, score: 100 } },
        { id: "w3", label: "\u8BF7\u53EA\u56DE\u590D\u4E00\u4E2A\u5355\u8BCD\uFF1APONG", model: "kimi-k2.6", priority: { tier: 0, score: 200 } },
        { id: "w4", label: "\u8BF7\u53EA\u56DE\u590D\u4E00\u4E2A\u5355\u8BCD\uFF1APONG", model: "glm-4.5-air", priority: { tier: 2, score: 900 } }
      ];
      const campaign = ctx.hufu.createCampaign(agent, config, items);
      while (campaign.freeSlots() > 0 && campaign.nextQueued().length > 0) {
        await campaign.dispatchNext();
      }
      const snapshot = campaign.serialize();
      const restored = HufuCampaign.restore(snapshot, {
        now: () => Date.now(),
        dispatch: { dispatch: async () => {
        } },
        interrupt: { interrupt: async () => {
        } },
        board: { pathOf: (group) => `/boards/${group}/FINDINGS.md` }
      });
      const replayOk = restored.ledger.views().every((v) => {
        const original = campaign.ledger.view(v.item.id);
        return original !== void 0 && original.state === v.state;
      });
      const deadline = Date.now() + 24e4;
      let retried = 0;
      while (!campaign.isComplete() && Date.now() < deadline) {
        while (campaign.freeSlots() > 0 && campaign.nextQueued().length > 0) {
          await campaign.dispatchNext();
        }
        await sleep(1e3);
        const failed = campaign.ledger.views().filter((v) => v.state === "failed");
        if (failed.length > 0 && retried < 2) {
          retried += 1;
          for (const f of failed) {
            campaign.ledger.append(f.item.id, { type: "requeue", at: Date.now(), seed: f.seed + 1, reason: "e2e retry" });
          }
        }
      }
      const summary = campaign.summary();
      const details = campaign.ledger.views().map((v) => `${v.item.id}#${v.seed}: ${v.state}`).join(" | ");
      return `summary=${JSON.stringify(summary)}
replayOk=${replayOk}
details=${details}`;
    }
  }));
}
export {
  apply,
  inject,
  name
};

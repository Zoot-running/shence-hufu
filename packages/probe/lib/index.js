// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var name = "shence-hufu-probe";
var inject = ["tools", "hufu"];
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "hufu_probe",
    description: "Run a mini hufu campaign: dispatch two trivial work items to two different models in parallel and return the campaign summary.",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("hufu_probe requires a calling agent");
      const campaign = ctx.hufu.createCampaign(
        agent,
        { concurrency: 2, stallAfterMs: 12e4, heartbeatMs: 9e4 },
        [
          { id: "p1", label: "\u8BF7\u53EA\u56DE\u590D\u4E00\u4E2A\u5355\u8BCD\uFF1APONG", model: "kimi-k2.6", priority: { tier: 0, score: 100 } },
          { id: "p2", label: "\u8BF7\u53EA\u56DE\u590D\u4E00\u4E2A\u5355\u8BCD\uFF1APONG", model: "glm-4.5-air", priority: { tier: 0, score: 100 } }
        ]
      );
      await campaign.dispatchNext();
      await campaign.dispatchNext();
      const deadline = Date.now() + 18e4;
      while (!campaign.isComplete() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const summary = campaign.summary();
      const details = campaign.ledger.views().map((v) => `${v.item.id}#${v.seed}: ${v.state}`).join(" | ");
      return `summary=${JSON.stringify(summary)}
details=${details}`;
    }
  }));
}
export {
  apply,
  inject,
  name
};

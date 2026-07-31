const { getState } = require("@saltcorn/data/db/state");
const WorkflowRuns = require("@saltcorn/data/models/workflow_run");

const { mockReqRes } = require("@saltcorn/data/tests/mocks");
const { afterAll, beforeAll, describe, it, expect } = require("@jest/globals");

const {
  CLEARED_TEXT,
  SUMMARY_OPEN,
  extractSummary,
  isSummaryMessage,
} = require("../skills/compaction_lib");
const { pendingToolCalls } = require("../common");

/*

 RUN WITH:
  saltcorn dev:plugin-test -d ~/agents -o ~/large-language-model/

 Unlike compaction.test.js, which stubs `generate` and hand-writes every
 fixture, this suite drives real models through real tool calls and then
 compacts the chat the backend itself produced. That is the only way to catch a
 chat that compaction leaves in a shape the provider rejects.

 */

afterAll(require("@saltcorn/data/db").close);
beforeAll(async () => {
  await require("@saltcorn/data/db/reset_schema")();
  await require("@saltcorn/data/db/fixtures")();
  getState().registerPlugin("base", require("@saltcorn/data/base-plugin"));
  await getState().setConfig("log_level", 1);
});

jest.setTimeout(180000);

const user = { id: 1, role_id: 1 };
const action = require("../action");

// A tool that returns far more than anyone wants to read, with one fact buried
// in it that the agent has to remember across the compaction.
const READINGS_CODE = `
const peaks = {alpha: 4711, beta: 3122, gamma: 8054};
const name = (sensor || "alpha").toLowerCase();
const peak = peaks[name] || 1000;
const lines = [];
for (let i = 0; i < 300; i++)
  lines.push(
    \`\${name}-\${i} time=2026-01-\${(i % 28) + 1} value=\${(i * 37) % 900} \` +
      \`status=nominal calibration=factory batch=\${1000 + i} note=routine reading\`
  );
lines.push(\`\${name} PEAK VALUE = \${peak}\`);
return lines.join("\\n");
`;

const compaction_agent_cfg = (compaction) => ({
  model: "",
  prompt: "{{theprompt}}",
  sys_prompt:
    "You are a sensor data analyst. Use the get_readings tool to look up the readings log for a sensor. Answer concisely.",
  skills: [
    {
      mode: "Tool",
      tool_name: "get_readings",
      tool_description: "Get the full readings log for one sensor",
      skill_type: "Run JavaScript code",
      js_code: READINGS_CODE,
      toolargs: [
        {
          name: "sensor",
          description: "Sensor name: alpha, beta or gamma",
          argtype: "string",
        },
      ],
    },
    { skill_type: "Compaction", ...compaction },
  ],
});

const chatOf = async (run_id) =>
  (await WorkflowRuns.findOne({ id: run_id })).context.interactions;

const contextOf = async (run_id) =>
  (await WorkflowRuns.findOne({ id: run_id })).context;

for (const nameconfig of require("./configs")) {
  const { name, ...config } = nameconfig;
  describe("compaction with real LLM: " + name, () => {
    beforeAll(async () => {
      getState().registerPlugin(
        "@saltcorn/large-language-model",
        require("@saltcorn/large-language-model"),
        config,
      );
      getState().registerPlugin("@saltcorn/agents", require(".."));
      const runs = await WorkflowRuns.find({});
      for (const run of runs) await run.delete();
    });

    const ask = async (theprompt, configuration, run_id) =>
      await action.run({
        row: { theprompt },
        configuration,
        user,
        run_id,
        req: { ...mockReqRes.req, user },
      });

    it("clears old tool results and keeps answering", async () => {
      const cfg = compaction_agent_cfg({
        trigger_tokens: 3000,
        strategy: "Clear old tool results",
        min_clear_tokens: 0,
        protect_tool_output_tokens: 0,
      });
      const first = await ask("What is the peak value of sensor alpha?", cfg);
      expect(first.json.response).toContain("4711");
      const run_id = first.json.run_id;

      await ask("Now look up sensor beta and give me its peak.", cfg, run_id);
      const third = await ask(
        "And sensor gamma - what is its peak value?",
        cfg,
        run_id,
      );
      expect(third.json.response).toContain("8054");

      const context = await contextOf(run_id);
      expect(context.compaction.count).toBeGreaterThan(0);
      expect(context.compaction.cleared).toBeGreaterThan(0);
      expect(JSON.stringify(context.interactions)).toContain(CLEARED_TEXT);
      expect(pendingToolCalls(context.interactions)).toEqual([]);
    });

    it("summarizes older messages and carries on", async () => {
      const cfg = compaction_agent_cfg({
        trigger_tokens: 3000,
        strategy: "Summarize older messages",
        keep_recent_tokens: 500,
      });
      const first = await ask("What is the peak value of sensor alpha?", cfg);
      const run_id = first.json.run_id;
      await ask("Now look up sensor beta and give me its peak.", cfg, run_id);
      await ask("And now sensor gamma, please.", cfg, run_id);

      const chat = await chatOf(run_id);
      expect(chat.filter(isSummaryMessage).length).toBe(1);
      expect(extractSummary(chat)).toContain("##");
      expect(pendingToolCalls(chat)).toEqual([]);

      // the summarized chat is still one the provider accepts
      const after = await ask(
        "Which sensor did I ask you about first?",
        cfg,
        run_id,
      );
      expect(after.json.success).toBe("ok");
      expect(after.json.response.toLowerCase()).toContain("alpha");
    });

    it("compacts on /compact and answers the next question", async () => {
      // exactly the reported case: compaction only ever fires from the command
      const cfg = compaction_agent_cfg({
        trigger_tokens: 10 ** 9,
        strategy: "Both",
        min_clear_tokens: 0,
        protect_tool_output_tokens: 0,
        keep_recent_tokens: 500,
      });
      const first = await ask("What is the peak value of sensor alpha?", cfg);
      const run_id = first.json.run_id;
      await ask("Now look up sensor beta and give me its peak.", cfg, run_id);

      const compacted = await ask("/compact keep the peak values", cfg, run_id);
      expect(compacted.json.success).toBe("ok");

      const context = await contextOf(run_id);
      expect(context.compaction.count).toBeGreaterThan(0);
      expect(JSON.stringify(context.interactions)).toContain(SUMMARY_OPEN);
      expect(pendingToolCalls(context.interactions)).toEqual([]);

      const after = await ask(
        "Without calling any tool, what was the peak value of sensor beta?",
        cfg,
        run_id,
      );
      expect(after.json.success).toBe("ok");
      expect(after.json.response).toContain("3122");
    });
  });
}

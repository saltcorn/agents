const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const Trigger = require("@saltcorn/data/models/trigger");
const Table = require("@saltcorn/data/models/table");
const {
  get_skills,
  getCompletionArguments,
  process_interaction,
  get_skill_instances,
  wrapSegment,
} = require("./common");
const {
  createAuditTrailRun,
  logToAuditTrailTable,
} = require("./audit-trail");
const { p } = require("@saltcorn/markup/tags");
const { escapeHtml } = require("@saltcorn/data/utils");
const { applyAsync } = require("@saltcorn/data/utils");
const WorkflowRun = require("@saltcorn/data/models/workflow_run");
const { interpolate } = require("@saltcorn/data/utils");
const { getState } = require("@saltcorn/data/db/state");

const configuration_workflow = () =>
  new Workflow({
    steps: [
      {
        name: "Audit trail",
        form: async (context) => {
          return new Form({
            fields: [
              {
                name: "audit_trail",
                label: "Audit trail",
                sublabel:
                  "Record every agent run and every message from the user and the LLM in the agentsAuditTrailRun and agentsAuditTrailMsg tables",
                type: "Bool",
              },
            ],
          });
        },
      },
    ],
  });

module.exports = {
  sc_plugin_api_version: 1,
  configuration_workflow,
  dependencies: ["@saltcorn/large-language-model", "@saltcorn/json","@saltcorn/html"],
  viewtemplates: (modcfg) => [require("./agent-view")(modcfg)],
  plugin_name: "agents",
  ready_for_mobile: true,
  headers: () => [
    {
      script: `/plugins/public/agents@${
        require("./package.json").version
      }/markdown-it.min.js`,
      onlyViews: ["Agent Chat", "Saltcorn Agent copilot"],
    },
    {
      script: `/plugins/public/agents@${
        require("./package.json").version
      }/purify.min.js`,
      onlyViews: ["Agent Chat", "Saltcorn Agent copilot"],
    },
    {
      script: `/plugins/public/agents@${
        require("./package.json").version
      }/jquery.autogrow-textarea.js`,
      onlyViews: ["Agent Chat", "Saltcorn Agent copilot"],
    },
  ],
  actions: (modcfg) => ({
    Agent: require("./action")(modcfg),
    consolidate_agent_memory: require("./consolidate_agent_memory"),
  }),
  functions: (modcfg) => ({
    inspect_agent: {
      run: async (agent, user, row) => {
        const action = agent.runWithoutRow
          ? agent
          : await Trigger.findOne(
              typeof agent == "number" ? { id: agent } : { name: agent },
            );
        const complArgs = await getCompletionArguments(
          action.configuration,
          user,
          row,
        );
        const skills = get_skill_instances(action.configuration);
        const skill_tools = [];
        for (const skill of skills) {
          const skillTools = skill.provideTools?.();
          const tools = !skillTools
            ? []
            : Array.isArray(skillTools)
              ? skillTools
              : [skillTools];
          skill_tools.push(...tools);
        }
        return {
          ...complArgs,
          action,
          skills,
          skill_tools,
        };
      },
      isAsync: true,
      hidden: true,
      description: "Return system prompt, tools and action of an agent",
    },
    agent_generate: {
      run: async (agent_name, prompt, opts = {}) => {
        const action = await Trigger.findOne({ name: agent_name });
        let run;
        let context = {
          implemented_fcall_ids: [],
          interactions: [
            ...(opts.interactions || []),
            { role: "user", content: prompt },
          ],
          funcalls: {},
        };
        let newRun = false;
        if (opts.run_id === null || (!opts.run_id && opts.run === null)) {
          run = { context };
          newRun = true;
        } else if (opts.run) run = opts.run;
        else if (opts.run_id)
          run = await WorkflowRun.findOne({ id: +opts.run_id });
        else {
          run = await WorkflowRun.create({
            status: "Running",
            started_by: opts.user?.id,
            trigger_id: action.id,
            context,
          });
          newRun = true;
        }
        // the prompt is only in the chat of a new run
        if (newRun) {
          await createAuditTrailRun({ modcfg, run, user: opts.user, action });
          await logToAuditTrailTable({
            modcfg,
            run,
            user: opts.user,
            action,
            role: "user",
            interaction: [{ role: "user", content: prompt }],
            html: wrapSegment(p(escapeHtml(prompt)), "You", true),
          });
        }
        const result = await process_interaction(
          run,
          action.configuration,
          {
            user: opts?.user,
            body: {},
            disable_markdown_render:
              typeof opts.disable_markdown_render !== "undefined"
                ? opts.disable_markdown_render
                : !opts?.render_markdown,
          },
          null,
          [],
          {},
          { stream: false },
          false,
          false,
          modcfg,
        );
        return {
          text: result.json.response,
          run,
          ...(run.id ? { run_id: run.id } : {}),
        };
      },
      isAsync: true,
      hidden: true,
      description: "Run an agent on a prompt",
      arguments: [
        { name: "agent_name", type: "String" },
        { name: "prompt", type: "String" },
      ],
    },
  }),
};

/* 
TODO

-embedding retrieval list view
-optional user confirm: action, insert
-Preload data
-sql access
-memory

*/

const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const Trigger = require("@saltcorn/data/models/trigger");
const Table = require("@saltcorn/data/models/table");
const {
  get_skills,
  getCompletionArguments,
  process_interaction,
} = require("./common");
const { applyAsync } = require("@saltcorn/data/utils");
const WorkflowRun = require("@saltcorn/data/models/workflow_run");
const { interpolate } = require("@saltcorn/data/utils");
const { getState } = require("@saltcorn/data/db/state");

module.exports = {
  sc_plugin_api_version: 1,
  dependencies: ["@saltcorn/large-language-model"],
  viewtemplates: [require("./agent-view")],
  plugin_name: "agents",
  headers: [
    {
      script: `/plugins/public/agents@${
        require("./package.json").version
      }/markdown-it.min.js`,
      onlyViews: ["Agent Chat"],
    },
  ],
  actions: {
    Agent: require("./action"),
  },
  functions: {
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
        if (opts.run_id === null || (!opts.run_id && opts.run === null))
          run = { context };
        else if (opts.run) run = opts.run;
        else if (opts.run_id)
          run = await WorkflowRun.findOne({ id: +opts.run_id });
        else
          run = await WorkflowRun.create({
            status: "Running",
            started_by: opts.user?.id,
            trigger_id: action.id,
            context,
          });
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
        );
        return {
          text: result.json.response,
          run,
          ...(run.id ? { run_id: run.id } : {}),
        };
      },
      isAsync: true,
      description: "Run an agent on a prompt",
      arguments: [
        { name: "agent_name", type: "String" },
        { name: "prompt", type: "String" },
      ],
    },
  },
};

/* 
TODO

-embedding retrieval list view
-optional user confirm: action, insert
-Preload data
-sql access
-memory

*/

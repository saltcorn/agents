const { div, pre, a } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const Trigger = require("@saltcorn/data/models/trigger");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { fieldProperties } = require("./helpers");
const agent_action = require("../action");

class SubagentToSkill {
  static skill_name = "Subagent";

  get skill_label() {
    return this.agent_name;
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  systemPrompt() {
    const trigger = Trigger.findOne({ name: this.agent_name });
    if (trigger.description)
      return `${this.agent_name} tool: ${trigger.description}`;
    else return "";
  }

  static async configFields() {
    const actions = await Trigger.find({ action: "Agent" });

    return [
      {
        name: "agent_name",
        label: "Agent",
        sublabel: a(
          {
            "data-dyn-href": `\`/actions/configure/\${agent_name}\``,
            target: "_blank",
          },
          "Configure",
        ),
        type: "String",
        required: true,
        attributes: { options: actions.map((a) => a.name) },
      },
      // TODO: confirm, show response, show argument
    ];
  }

  provideTools = () => {
    let properties = {};

    const trigger = Trigger.findOne({ name: this.agent_name });
    if (!trigger)
      throw new Error(`Trigger skill: cannot find trigger ${this.agent_name}`);

    return {
      type: "function",
      process: async (row, { req }) => {
        //const result = await trigger.runWithoutRow({ user: req?.user, row });
        return "Workflow started";
      },
      /*renderToolCall({ phrase }, { req }) {
        return div({ class: "border border-primary p-2 m-2" }, phrase);
      },*/
      postProcess: async ({ tool_call, req, generate, emit_update, run }) => {
        const subres = await agent_action.run({
          row: {},
          configuration: { ...trigger.configuration, prompt: "continue" },
          user: req.user,
          run_id: run.id,
          is_sub_agent: true,
          req,
        });
        if (subres.json.raw_responses)
          return { add_response: subres.json.raw_responses.join("") };
        return {
          //stop: true,
          //add_response: result,
        };
      },
      function: {
        name: trigger.name,
        description: trigger.description,
        parameters: {
          type: "object",
          //required: ["action_javascript_code", "action_name"],
          properties,
        },
      },
    };
  };
}

module.exports = SubagentToSkill;

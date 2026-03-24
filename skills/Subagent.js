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
const { replaceUserContinue } = require("../common");

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
      {
        name: "handover_prompt",
        label: "Handover prompt",
        sublabel: `Optional. The prompt initialising the subagent. Example: "Continue answering my query using the tool now at you disposal"`,
        type: "String",
      },
      {
        name: "handoff_prompt",
        label: "Handoff prompt",
        sublabel: `Optional. A prompt to process the results of the subagent. Example: "Analyze this response in relation to my query"`,
        type: "String",
      },
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
      postProcess: async ({
        tool_call,
        req,
        generate,
        emit_update,
        run,
        chat,
        agent_view_config,
        dyn_updates,
      }) => {
        getState().log(6, "Running subagent", this.agent_name);
        const subres = await agent_action.run({
          row: {},
          configuration: {
            ...trigger.configuration,
            prompt:
              this.handover_prompt ||
              "Your instructions and tools have changed. Continue answering my query using the instructions and tools at you disposal, if any",
          },
          user: req.user,
          run,
          is_sub_agent: true,
          agent_view_config,
          dyn_updates,
          req,
        });
        getState().log(6, "Subagent response", JSON.stringify(subres, null, 2));
        //if (subres.json.raw_responses)
        //  return { add_responses: subres.json.raw_responses };
        return {
          ...(this.handoff_prompt
            ? { follow_up_prompt: this.handoff_prompt }
            : { stop: true }),

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

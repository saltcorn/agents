const { div, pre, a } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const Trigger = require("@saltcorn/data/models/trigger");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { fieldProperties } = require("./helpers");

class TriggerToSkill {
  static skill_name = "Trigger";

  get skill_label() {
    return this.trigger_name;
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  systemPrompt() {
    const trigger = Trigger.findOne({ name: this.trigger_name });

    return `${this.trigger_name} tool: ${trigger.description}`;
  }

  static async configFields() {
    const actions = (await Trigger.find({})).filter(
      (action) => action.description
    );
    const hasTable = actions.filter((a) => a.table_id).map((a) => a.name);
    const confirm_view_opts = {};
    for (const a of actions) {
      if (!a.table_id) continue;
      const views = await View.find({ table_id: a.table_id });
      confirm_view_opts[a.name] = views.map((v) => v.name);
    }
    return [
      {
        name: "trigger_name",
        label: "Action",
        sublabel:
          "Only actions with a description can be enabled. " +
          a(
            {
              "data-dyn-href": `\`/actions/configure/\${trigger_name}\``,
              target: "_blank",
            },
            "Configure"
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

    const trigger = Trigger.findOne({ name: this.trigger_name });
    if(!trigger) throw new Error(`Trigger skill: cannot find trigger ${this.trigger_name}`)

    if (trigger.table_id) {
      const table = Table.findOne({ id: trigger.table_id });

      table.fields
        .filter((f) => !f.primary_key)
        .forEach((field) => {
          properties[field.name] = {
            description: field.label + " " + field.description || "",
            ...fieldProperties(field),
          };
        });
    }
    return {
      type: "function",
      process: async (row, { req }) => {
        const result = await trigger.runWithoutRow({ user: req?.user, row });
        return result;
      },
      /*renderToolCall({ phrase }, { req }) {
        return div({ class: "border border-primary p-2 m-2" }, phrase);
      },*/
      renderToolResponse: async (response, { req }) => {
        return div({ class: "border border-success p-2 m-2" }, response);
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

module.exports = TriggerToSkill;

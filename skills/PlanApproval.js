const { div, pre, a } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const User = require("@saltcorn/data/models/user");
const File = require("@saltcorn/data/models/file");
const View = require("@saltcorn/data/models/view");
const Trigger = require("@saltcorn/data/models/trigger");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { interpolate, sleep } = require("@saltcorn/data/utils");
const { features } = require("@saltcorn/data/db/state");
const { button } = require("@saltcorn/markup/tags");
const { validID } = require("@saltcorn/markup/layout_utils");

const vm = require("vm");

//const { fieldProperties } = require("./helpers");

class PlanApprovalSkill {
  static skill_name = "Plan approval";

  get skill_label() {
    return "Plan approval";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    return [
      {
        name: "ini_sys_prompt",
        label: "Initial system prompt",
        type: "String",
        fieldview: "textarea",
        sublabel: "Refer to the tool as <code>submit_plan_for_approval</code>",
      },
      {
        name: "approval_prompt",
        label: "Prompt on approval",
        type: "String",
        fieldview: "textarea",
        sublabel: "If the user approves the plan, what should the agent do?",
      },
    ];
  }
  systemPrompt() {
    return this.ini_sys_prompt;
  }

  get userActions() {
    return {
      approve_plan: async () => {
        return { generate_prompt: this.approval_prompt };
      },
    };
  }

  provideTools = () => {
    return {
      type: "function",
      process: async (row) => {
        return {
          stop: true,
          add_response: row.plan,
          add_user_action: {
            name: "approve_plan",
            type: "button",
            label: `Approve`,
            click_replace_text: "Approved",
            input: {},
          },
        };
      },
      renderToolCall({ plan }) {
        return plan;
      },
      function: {
        name: "submit_plan_for_approval",
        description:
          "Submit a plan for approval by the user. If the plan is approved, further instructions about executing it may be given",
        parameters: {
          type: "object",
          required: ["plan"],
          properties: {
            plan: {
              description: "The plan",
              type: "string",
            },
          },
        },
      },
    };
  };
}

module.exports = PlanApprovalSkill;

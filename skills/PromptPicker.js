const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { select, option } = require("@saltcorn/markup/tags");
const { eval_expression } = require("@saltcorn/data/models/expression");

class PromptPicker {
  static skill_name = "Prompt picker";
  get skill_label() {
    return `Prompt picker`;
  }
  constructor(cfg) {
    Object.assign(this, cfg);
  }
  static async configFields() {
    return [
      {
        name: "options_obj",
        label: "System prompt contents",
        sublabel: `JavaScript object where the keys are the options and values are added to system prompt. Example:<br><code>{"Pirate":"Speak like a pirate", "Pop star":"Speak like a pop star"}</code>`,
        type: "String",
        fieldview: "textarea",
        required: true,
      },
    ];
  }
  async formWidget({ user, triggering_row, klass }) {
    const options = eval_expression(
      this.options_obj,
      triggering_row || {},
      user,
      "Prompt picker options"
    );
    return select(
      { class: ["form-select w-unset", klass] },
      Object.keys(options).map((o) => option(o))
    );
  }
}

module.exports = PromptPicker;

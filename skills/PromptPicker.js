const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { select, option } = require("@saltcorn/markup/tags");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { validID } = require("@saltcorn/markup/layout_utils");

class PromptPicker {
  static skill_name = "Prompt picker";
  get skill_label() {
    return `Prompt picker`;
  }
  constructor(cfg) {
    Object.assign(this, cfg);
    this.options = eval_expression(
      this.options_obj,
      {},
      null,
      "Prompt picker options"
    );
    this.formname = validID("pp" + Object.keys(this.options));
  }
  static async configFields() {
    return [
      { name: "placeholder", label: "Placeholder", type: "String" },
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
  async formWidget({ user, klass }) {
    return select(
      {
        class: ["form-select form-select-sm w-unset", klass],
        name: this.formname,
      },
      this.placeholder && option({ disabled: true }, this.placeholder),
      Object.keys(this.options).map((o) => option(o))
    );
  }
  systemPrompt(body) {
    if (body[this.formname]) return this.options[body[this.formname]];
  }
}

module.exports = PromptPicker;

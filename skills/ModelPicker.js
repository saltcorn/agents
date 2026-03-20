const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { select, option } = require("@saltcorn/markup/tags");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { validID } = require("@saltcorn/markup/layout_utils");
const { getState } = require("@saltcorn/data/db/state");

class ModelPicker {
  static skill_name = "Model picker";
  get skill_label() {
    return `Model picker`;
  }
  constructor(cfg) {
    Object.assign(this, cfg);
  }
  static async configFields() {
    return [
      { name: "placeholder", label: "Placeholder", type: "String" },
      {
        name: "default_label",
        label: "Default configuration label",
        type: "String",
      },
    ];
  }
  async formWidget({ user, klass }) {
    const llm_cfg_fun = getState().functions.llm_get_configuration;
    const alt_config_options = llm_cfg_fun
      ? llm_cfg_fun.run().alt_config_names || []
      : [];
    return select(
      {
        class: ["form-select form-select-sm w-unset", klass],
        name: "modelpicker",
      },
      this.placeholder && option({ disabled: true }, this.placeholder),
      option({ value: "" }, this.default_label),
      alt_config_options.map((o) => option(o)),
    );
  }
  settingsOverride(body) {
    if (body.modelpicker) return { alt_config: body.modelpicker };
  }
}

module.exports = ModelPicker;

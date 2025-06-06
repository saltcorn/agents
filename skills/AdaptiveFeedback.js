const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");

class AdaptiveFeedback {
  static skill_name = "Adaptive Feedback";
  static async configFields() {
    return [
      {
        name: "label",
        label: "Label",
        type: "String",
      },
    ];
  }

  onEvolve() {}

  provideTools() {}
}

module.exports = AdaptiveFeedback;

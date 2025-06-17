const { div, pre } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { interpolate } = require("@saltcorn/data/utils");

class GenerateImage {
  static skill_name = "Image generation";

  get skill_label() {
    return `Image generation`;
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    return [];
  }

  provideTools() {
    return {
      type: "image_generation",
      size: "1024x1024",
      quality: "low",
      renderToolResponse: (v) => {        
        return `<img src="data:image/${v.output_format};base64, ${v.result}" />`;
      },
    };
  }
}

module.exports = GenerateImage;

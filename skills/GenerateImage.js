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
    return [
      {
        name: "quality",
        label: "Quality",
        type: "String",
        required: true,
        attributes: { options: ["auto", "low", "medium", "high"] },
      },
      {
        name: "size",
        label: "Size",
        type: "String",
        required: true,
        attributes: {
          options: ["auto", "1024x1024", "1536x1024", "1024x1536"],
        },
      },
      {
        name: "format",
        label: "Format",
        type: "String",
        required: true,
        attributes: { options: ["png", "jpeg", "webp"] },
      },
      {
        name: "transparent",
        label: "Transparent",
        type: "Bool",
      },
    ];
  }

  provideTools() {
    const tool = {
      type: "image_generation",
      size: this.size,
      quality: this.quality,
      renderToolResponse: (v) => {
        const [ws, hs] = this.size.split("x")
        return `<img height="${+hs/4}" width="${+ws/4}" src="data:image/${v.output_format};base64, ${v.result}" />`;
      },
    };
    if (this.transparent) tool.background = "transparent";
    return tool;
  }
}

module.exports = GenerateImage;

const { div, pre } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
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
      {
        name: "save_file",
        label: "Save file",
        type: "String",
        required: true,
        attributes: { options: ["Always", "Never", "Button"] },
      },
    ];
  }

  provideTools() {
    const tool = {
      type: "image_generation",
      size: this.size,
      quality: this.quality,
      process: async (v, { req }) => {
        if (this.save_file === "Always") {
          const buf = Buffer.from(v.result, "base64");
          const file = await File.from_contents(
            `genimg.${v.output_format}`,
            `image/${v.output_format}`,
            buf,
            req?.user?.id,
            100
          );
          return { filename: file.path_to_serve };
        }
      },
      renderToolResponse: (v) => {
        const [ws, hs] = v.size.split("x");
        if (v.filename)
          return `<img height="${+hs / 4}" width="${
            +ws / 4
          }" src="/files/serve/${v.filename}" />`;
        else
          return `<img height="${+hs / 4}" width="${+ws / 4}" src="data:image/${
            v.output_format
          };base64, ${v.result}" />`;
      },
    };
    if (this.transparent) tool.background = "transparent";
    return tool;
  }
}

module.exports = GenerateImage;

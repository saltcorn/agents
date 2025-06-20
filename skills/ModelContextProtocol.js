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

class ModelContextProtocol {
  static skill_name = "Model Context Protocol";

  get skill_label() {
    return `Model Context Protocol: ${this.server_label}`;
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    return [
      {
        name: "server_label",
        label: "Server label",
        type: "String",
        required: true,
      },
      {
        name: "server_url",
        label: "Server URL",
        type: "String",
        required: true,
      },
      {
        name: "header_key",
        label: "Header key",
        type: "String",
        sublabel:
          "Optional, for authorization. Which HTTP header should be set? For example <code>Authorization</code>",
      },
      {
        name: "header_value",
        label: "Header value",
        type: "String",
        sublabel:
          "Optional, for authorization. What is the value of the HTTP header? For example <code>Bearer {api_key}</code>",
      },
    ];
  }

  provideTools() {
    const tool = {
      type: "mcp",
      server_label: this.server_label,
      server_url: this.server_url,
    };
    if (this.header_key && this.header_value)
      tool.headers = { [this.header_key]: this.header_value };
    return tool;
  }
}

module.exports = ModelContextProtocol;

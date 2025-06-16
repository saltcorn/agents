const { div, pre } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { interpolate } = require("@saltcorn/data/utils");

class PreloadData {
  static skill_name = "Preload Data";

  get skill_label() {
    return `Preload Data`;
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  async systemPrompt({ user }) {
    const prompts = [];
    if (this.add_sys_prompt) prompts.push(this.add_sys_prompt);
    const table = Table.findOne(this.table_name);
    const q = eval_expression(this.query, {}, user, "PreloadData query");

    const rows = await table.getRows(q);
    if (this.contents_expr) {
      for (const row in rows)
        prompts.push(interpolate(this.contents_expr, row, user));
    } else {
      for (const row in rows) {
        this.hidden_fields.forEach((k) => {
          delete row[k];
        });
        prompts.push(JSON.stringify(row));
      }
    }
    return prompts.join("\n");
  }

  static async configFields() {
    const allTables = await Table.find();

    return [
      {
        name: "table_name",
        label: "Table",
        sublabel: "Which table to search",
        type: "String",
        required: true,
        attributes: { options: allTables.map((t) => t.name) },
      },
      {
        name: "query",
        label: "Query",
        type: "String",
        class: "validate-expression",
      },
      {
        name: "add_sys_prompt",
        label: "Additional prompt",
        type: "String",
        fieldview: "textarea",
      },
      {
        name: "contents_expr",
        label: "Contents string",
        type: "String",
        sublabel:
          "Use handlebars (<code>{{ }}</code>) to access fields in each retrieved row",
      },
      {
        name: "hidden_fields",
        label: "Hide fields",
        type: "String",
        sublabel:
          "Comma-separated list of fields to hide from the prompt, if not using the contents string",
      },
    ];
  }
}

module.exports = PreloadData;

const { div, pre } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const File = require("@saltcorn/data/models/file");
const Trigger = require("@saltcorn/data/models/trigger");
const User = require("@saltcorn/data/models/user");
const View = require("@saltcorn/data/models/view");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { interpolate } = require("@saltcorn/data/utils");
const vm = require("vm");
const fetch = global.fetch || require("node-fetch");

class PreloadData {
  static skill_name = "Preload Data";

  get skill_label() {
    return `Preload Data`;
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  async run_the_code({ user, triggering_row }) {
    const sysState = getState();
    const f = vm.runInNewContext(`async () => {${this.code}\n}`, {
      Table,
      row: triggering_row,
      context: triggering_row,
      user,
      User,
      File,
      Buffer,
      Trigger,
      setTimeout,
      interpolate,
      fetch,
      require,
      getConfig: (k) =>
        sysState.isFixedConfig(k) ? undefined : sysState.getConfig(k),
      ...(triggering_row || {}),
      ...sysState.eval_context,
    });
    return await f();
  }

  async initialInteractions({ user, triggering_row }) {
    if (this._stashed_initial_interactions)
      return this._stashed_initial_interactions;
    if (this.data_source === "Code") {
      const result = await this.run_the_code({ user, triggering_row });
      return result?.interactions;
    }
  }

  async systemPrompt({ user, triggering_row }) {
    const prompts = [];
    if (this.data_source === "Code") {
      const result = await this.run_the_code({ user, triggering_row });
      if (typeof result === "string") return result;
      if (result?.interactions)
        this._stashed_initial_interactions = result?.interactions;
      if (result?.systemPrompt) return result.systemPrompt;
    } else {
      if (this.add_sys_prompt) prompts.push(this.add_sys_prompt);
      const table = Table.findOne(this.table_name);
      const q = eval_expression(
        this.preload_query,
        triggering_row || {},
        user,
        "PreloadData query"
      );

      const rows = await table.getRows(q);
      if (this.contents_expr) {
        for (const row of rows)
          prompts.push(interpolate(this.contents_expr, row, user));
      } else {
        const hidden_fields = this.hidden_fields
          .split(",")
          .map((s) => s.trim());
        for (const row of rows) {
          hidden_fields.forEach((k) => {
            delete row[k];
          });
          prompts.push(JSON.stringify(row));
        }
      }
    }
    return prompts.join("\n");
  }

  static async configFields() {
    const allTables = await Table.find();

    return [
      {
        name: "data_source",
        label: "Data source",
        type: "String",
        required: true,
        attributes: { options: ["Table", "Code"] },
      },
      {
        name: "code",
        label: "Code",
        input_type: "code",
        attributes: { mode: "application/javascript" },
        showIf: { data_source: "Code" },
        class: "validate-statements",
        sublabel:
          "Return string or object <code>{systemPrompt: string, interactions: Interaction[]}</code>",
        validator(s) {
          try {
            let AsyncFunction = Object.getPrototypeOf(
              async function () {}
            ).constructor;
            AsyncFunction(s);
            return true;
          } catch (e) {
            return e.message;
          }
        },
      },
      {
        name: "table_name",
        label: "Table",
        sublabel: "Which table to search",
        type: "String",
        required: true,
        attributes: { options: allTables.map((t) => t.name) },
        showIf: { data_source: "Table" },
      },
      {
        name: "preload_query",
        label: "Query",
        type: "String",
        class: "validate-expression",
        showIf: { data_source: "Table" },
      },
      {
        name: "add_sys_prompt",
        label: "Additional prompt",
        type: "String",
        showIf: { data_source: "Table" },
        fieldview: "textarea",
      },
      {
        name: "contents_expr",
        label: "Contents string",
        type: "String",
        fieldview: "textarea",
        showIf: { data_source: "Table" },
        sublabel:
          "Use handlebars (<code>{{ }}</code>) to access fields in each retrieved row",
      },
      {
        name: "hidden_fields",
        label: "Hide fields",
        type: "String",
        showIf: { data_source: "Table" },
        sublabel:
          "Comma-separated list of fields to hide from the prompt, if not using the contents string",
      },
    ];
  }
}

module.exports = PreloadData;

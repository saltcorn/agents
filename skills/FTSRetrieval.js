const { div, pre } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");

class RetrievalByFullTextSearch {
  static skill_name = "Retrieval by full-text search";

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  get toolName() {
    return `search_${this.table_name.replaceAll(" ", "")}`;
  }

  systemPrompt() {
    if (this.mode === "Tool")
      return `Use the ${this.toolName} tool to search the ${this.table_name} database by a search phrase which will locate rows where any field match that query`;
  }

  static async configFields() {
    const allTables = await Table.find();
    const list_view_opts = {};
    for (const t of allTables) {
      const lviews = await View.find_table_views_where(
        t.id,
        ({ state_fields, viewrow }) =>
          viewrow.viewtemplate !== "Edit" &&
          state_fields.every((sf) => !sf.required)
      );
      list_view_opts[t.name] = lviews.map((v) => v.name);
    }
    return [
      {
        name: "mode",
        label: "Mode",
        type: "String",
        required: true,
        attributes: { options: ["Tool", "Search on every user input"] },
      },
      {
        name: "table_name",
        label: "Table",
        sublabel: "Which table to search",
        type: "String",
        required: true,
        attributes: { options: allTables.map((t) => t.name) },
      },
      {
        name: "list_view",
        label: "List view",
        type: "String",
        attributes: {
          calcOptions: ["table_name", list_view_opts],
        },
      },
      {
        name: "contents_expr",
        label: "Contents string",
        type: "String",
        sublabel:
          "Use handlebars (<code>{{ }}</code>) to access fields in the retrieved rows",
      },
    ];
  }

  onMessage(msgs) {
    if (this.mode !== "Search on every user input") return;
  }

  provideTools() {
    if (this.mode !== "Tool") return [];
    const table = Table.findOne(this.table_name);
    return {
      type: "function",
      async process({ phrase }) {
        const scState = getState();
        const language = scState.pg_ts_config;
        const use_websearch = scState.getConfig("search_use_websearch", false);
        const rows = await table.getRows({
          _fts: {
            fields: table.fields,
            searchTerm: phrase,
            language,
            use_websearch,
            table: table.name,
            schema: db.isSQLite ? undefined : db.getTenantSchema(),
          },
        });
        if (rows.length) return { rows };
        else
          return {
            response: "There are no rows related to: " + phrase,
          };
      },
      /*renderToolCall({ phrase }, { req }) {
        return div({ class: "border border-primary p-2 m-2" }, phrase);
      },*/
      renderToolResponse: async ({ response, rows }, { req }) => {
        if (rows) {
          const view = View.findOne({ name: this.list_view });

          if (view) {
            const viewRes = await view.run(
              { [table.pk_name]: { in: rows.map((r) => r[table.pk_name]) } },
              { req }
            );
            return viewRes;
          } else return "";
        }
        return div({ class: "border border-success p-2 m-2" }, response);
      },
      function: {
        name: this.toolName,
        description: `Search the ${this.table_name} database table ${
          table.description ? `(${table.description})` : ""
        } by a search phrase matched against all fields in the table with full text search. The retrieved rows will be returned`,
        parameters: {
          type: "object",
          required: ["phrase"],
          properties: {
            phrase: {
              type: "string",
              description: "The phrase to search the table with",
            },
          },
        },
      },
    };
  }
}

module.exports = RetrievalByFullTextSearch;

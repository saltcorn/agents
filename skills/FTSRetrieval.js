const { div, pre } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { interpolate } = require("@saltcorn/data/utils");
const { nubBy } = require("../common");

class RetrievalByFullTextSearch {
  static skill_name = "Retrieval by full-text search";

  get skill_label() {
    return `Search ${this.table_name}`;
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  get toolName() {
    return `search_${this.table_name.replaceAll(" ", "")}`;
  }

  systemPrompt() {
    if (this.mode === "Tool")
      return `Use the ${this.toolName} tool to search the ${
        this.table_name
      } database by a search phrase (using the syntax of web search engines) which will locate rows where any field match that query.${
        this.list_view
          ? ` When the tool call returns rows, do not describe them or repeat the information to the user. The results are already displayed to the user automatically.`
          : ""
      }${
        this.add_sys_prompt
          ? ` Additional information for the ${this.toolName} tool: ${this.add_sys_prompt}`
          : ""
      }`;
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
      list_view_opts[t.name] = ["", ...lviews.map((v) => v.name)];
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
        name: "hidden_fields",
        label: "Hide fields",
        type: "String",
        sublabel: "Comma-separated list of fields to hide from the prompt",
      },
      {
        name: "add_sys_prompt",
        label: "Additional prompt",
        type: "String",
        fieldview: "textarea",
      },
      {
        name: "doc_format",
        label: "Document format",
        type: "String",
        fieldview: "textarea",
        sublabel:
          "Format of text to send to LLM, use <code>{{ }}</code> to access variables in the document table. If not set, document will be sent as JSON",
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
      process: async (arg, { req }) => {
        const scState = getState();
        const language = scState.pg_ts_config;
        const use_websearch = scState.getConfig("search_use_websearch", false);
        let rows = [];
        const phrases =
          arg.query?.phrases ||
          arg.phrases ||
          (arg.phrase
            ? [arg.phrase]
            : arg.query?.phrase
            ? [arg.query?.phrase]
            : []);
        for (const phrase of phrases) {
          const my_rows = await table.getRows({
            _fts: {
              fields: table.fields,
              searchTerm: phrase,
              language,
              use_websearch,
              table: table.name,
              schema: db.isSQLite ? undefined : db.getTenantSchema(),
            },
          });
          if (this.hidden_fields) {
            const hidden_fields = this.hidden_fields
              .split(",")
              .map((s) => s.trim());
            my_rows.forEach((r) => {
              hidden_fields.forEach((k) => {
                delete r[k];
              });
            });
          }
          rows.push(...my_rows);
        }
        const pk = table.pk_name;
        rows = nubBy((r) => r[pk], rows);

        if (rows.length)
          if (!this.doc_format) return { rows };
          else {
            const responseText = rows
              .map((row) => interpolate(this.doc_format, row, req.user))
              .join("\n");
            return { rows, responseText };
          }
        else
          return {
            responseText:
              "There are no rows related to: " + phrases.join(" or "),
          };
      },
      /*renderToolCall({ phrase }, { req }) {
        return div({ class: "border border-primary p-2 m-2" }, phrase);
      },*/
      renderToolResponse: async ({ responseText, rows }, { req }) => {
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
        return div({ class: "border border-success p-2 m-2" }, responseText);
      },
      function: {
        name: this.toolName,
        description: `Search the ${this.table_name} database table${
          table.description ? ` (${table.description})` : ""
        } by one or several search phrase or multiple search phrases matched against all fields in the table with full text search. The retrieved rows will be returned. If you want to search for documents matching any of several phrases, call this tool once with the phrases argument and give all the phrases you want to search for in one tool call.`,
        parameters: {
          type: "object",
          required: ["query"],
          properties: {
            query: {
              anyOf: [
                {
                  type: "object",
                  required: ["phrase"],
                  properties: {
                    phrase: {
                      type: "string",
                      description:
                        "The phrase to search the table with. The search phrase is the synatx used by web search engines: use double quotes for exact match, unquoted text for words in any order, dash (minus sign) to exclude a word. Do not use SQL or any other formal query language.",
                    },
                  },
                },
                {
                  type: "object",
                  required: ["phrases"],
                  description:
                    "Search the table by any of a number of phrases. This will return any document that matches one or the other of the phrases",
                  properties: {
                    phrases: {
                      type: "array",
                      description:
                        "A phrase to search the table with. The search phrase is the synatx used by web search engines: use double quotes for exact match, unquoted text for words in any order, dash (minus sign) to exclude a word. Do not use SQL or any other formal query language.",
                      items: {
                        type: "string",
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    };
  }
}

module.exports = RetrievalByFullTextSearch;

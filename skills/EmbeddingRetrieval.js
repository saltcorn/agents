const { div } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");

class RetrievalByEmbedding {
  static skill_name = "Retrieval by embedding";

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  get toolName() {
    return `search_${this.table_name.replaceAll(" ", "")}`;
  }

  systemPrompt() {
    if (this.mode === "Tool") {
      const table = Table.findOne(this.vec_field.split["."][0]);

      return `Use the ${this.toolName} tool to search an archive named ${
        table.name
      }${
        table.description ? ` (${table.description})` : ""
      } for documents related to a search phrase or a question`;
    }
  }

  static async configFields() {
    const allTables = await Table.find();
    const tableOpts = [];
    const relation_opts = {};
    const list_view_opts = {};
    for (const table of allTables) {
      table.fields
        .filter((f) => f.type?.name === "PGVector")
        .forEach((f) => {
          const relNm = `${table.name}.${f.name}`;
          tableOpts.push(relNm);
          const fkeys = table.fields
            .filter((f) => f.is_fkey)
            .map((f) => f.name);
          relation_opts[relNm] = ["", ...fkeys];
          
          list_view_opts[relNm] = []
        });
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
        name: "vec_field",
        label: "Vector field",
        sublabel: "Field to search for vector similarity",
        type: "String",
        required: true,
        attributes: { options: tableOpts },
      },
      {
        name: "doc_relation",
        label: "Document relation",
        sublabel:
          "Optional. For each vector match, retrieve row in the table related by this key instead",
        type: "String",
        required: true,
        attributes: { calcOptions: ["vec_field", relation_opts] },
      },
       {
        name: "list_view",
        label: "List view",
        type: "String",
        attributes: {
          calcOptions: ["vec_field", list_view_opts],
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
    const table0 = Table.findOne(this.vec_field.split["."][0]);
    const table_docs = this.doc_relation
      ? Table.findOne(table0.getField(this.doc_relation).reftable_name)
      : table0;
    return {
      type: "function",
      process({ phrase_or_question }) {
        return {
          response: "There are no documents related to: " + phrase_or_question,
        };
      },
      renderToolResponse: async ({ response, rows }, { req }) => {
        if (rows) {
          const view = View.findOne({ name: this.list_view });

          if (view) {
            const viewRes = await view.run(
              {
                [table_docs.pk_name]: {
                  in: rows.map((r) => r[table_docs.pk_name]),
                },
              },
              { req }
            );
            return viewRes;
          } else return "";
        }
        return div({ class: "border border-success p-2 m-2" }, response);
      },
      function: {
        name: this.toolName,
        description: `Search the ${table_docs.name``} archive${
          table_docs.description ? ` (${table_docs.description})` : ""
        } for information related to a search phrase or a question. The relevant documents will be returned`,
        parameters: {
          type: "object",
          required: ["phrase_or_question"],
          properties: {
            phrase_or_question: {
              type: "string",
              description: "The phrase or question to search the archive with",
            },
          },
        },
      },
    };
  }
}

module.exports = RetrievalByEmbedding;

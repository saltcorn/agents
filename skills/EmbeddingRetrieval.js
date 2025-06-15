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
    return `search_${this.vec_field.split(".")[0].replaceAll(" ", "")}`;
  }

  systemPrompt() {
    if (this.mode === "Tool") {
      const table = Table.findOne(this.vec_field.split(".")[0]);

      return `Use the ${this.toolName} tool to search an archive named ${
        table.name
      }${
        table.description ? ` (${table.description})` : ""
      } for documents related to a search phrase or a question.${
        this.add_sys_prompt
          ? ` Additional information for the ${this.toolName} tool: ${this.add_sys_prompt}`
          : ""
      }`;
    }
  }

  static async configFields() {
    const allTables = await Table.find();
    const tableOpts = [];
    const relation_opts = {};
    const list_view_opts = {};
    for (const table of allTables) {
      for (const f of table.fields) {
        if (f.type?.name !== "PGVector") continue;
        const relNm = `${table.name}.${f.name}`;
        tableOpts.push(relNm);
        list_view_opts[relNm] = [""];
        const fkeys = table.fields.filter((f) => f.is_fkey).map((f) => f.name);
        relation_opts[relNm] = ["", ...fkeys];
        for (const fkeyField of table.fields.filter((f) => f.is_fkey)) {
          const t = Table.findOne(fkeyField.reftable_name);
          const lviews = await View.find_table_views_where(
            t.id,
            ({ state_fields, viewrow }) =>
              viewrow.viewtemplate !== "Edit" &&
              state_fields.every((sf) => !sf.required)
          );
          list_view_opts[relNm].push(...lviews.map((v) => v.name));
        }
      }
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
        name: "hidden_fields",
        label: "Hide fields",
        type: "String",
        sublabel: "Comma-separated list of fields to hide from the prompt",
      },
      {
        name: "limit",
        label: "Limit",
        sublabel: "Max number of rows to find",
        type: "String",
      },
      {
        name: "add_sys_prompt",
        label: "Additional prompt",
        type: "String",
        fieldview: "textarea",
      },
    ];
  }

  onMessage(msgs) {
    if (this.mode !== "Search on every user input") return;
  }

  provideTools() {
    if (this.mode !== "Tool") return [];
    const table0 = Table.findOne(this.vec_field.split(".")[0]);
    const table_docs = this.doc_relation
      ? Table.findOne(table0.getField(this.doc_relation).reftable_name)
      : table0;
    return {
      type: "function",
      process: async ({ phrase_or_question }) => {
        const [table_name, field_name] = this.vec_field.split(".");
        const table = Table.findOne({ name: table_name });
        if (!table)
          throw new Error(
            `Table ${table_name} not found in vector_similarity_search action`
          );
        const embedF = getState().functions.llm_embedding;
        const opts = {};
        const qembed = await embedF.run(phrase_or_question, opts);
        const selLimit = +(this.limit || 10);
        const rows = await table.getRows(
          {},
          {
            orderBy: {
              operator: "nearL2",
              field: field_name,
              target: JSON.stringify(qembed),
            },
            limit: this.doc_relation ? 5 * selLimit : selLimit,
          }
        );
        rows.forEach((r) => {
          delete r[field_name];
        });
        if (!rows.length)
          return {
            response:
              "There are no documents related to: " + phrase_or_question,
          };
        else if (!this.doc_relation) return { rows };
        else {
          const relField = table.getField(this.doc_relation);
          const relTable = Table.findOne(relField.reftable_name);
          const ids = [];
          rows.forEach((vrow) => {
            if (ids.length < selLimit) ids.push(vrow[this.doc_relation]);
          });
          const docsUnsorted = await relTable.getRows({ id: { in: ids } });
          //ensure order
          const docs = ids
            .map((id) => docsUnsorted.find((d) => d.id == id))
            .filter(Boolean);
          return { rows: docs };
        }
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
        description: `Search the ${table_docs.name} archive${
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

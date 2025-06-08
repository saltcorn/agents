const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");

class RAG {
  static skill_name = "Retrieval-Augmented Generation";

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  systemPrompt() {
    if (this.mode === "Tool")
      return `Use the rag tool to search an archive for documents related to a search phrase or a question`;
  }

  static async configFields() {
    const allTables = await Table.find();
    const tableOpts = [];
    const relation_opts = {};
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
    return {
      type: "function",
      process({ phrase_or_question }) {
        return {
          response: "There are no documents related to: "+phrase_or_question,
        };
      },
      function: {
        name: "rag",
        description: `Search an archive for imformation related to a search phrase or a question. The relevant documents will be returned`,
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

module.exports = RAG;

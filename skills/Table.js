const { div, pre } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { fieldProperties } = require("./helpers");

class TableToSkill {
  static skill_name = "Table";

  get skill_label() {
    return `${this.table_name} table`;
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  systemPrompt() {
    return `Use the query_${this.table_name} tool to search the ${
      this.table_name
    } database by a search phrase which will locate rows where any field match that query.${
      this.add_sys_prompt ? ` ${this.add_sys_prompt}` : ""
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
        name: "table_name",
        label: "Table",
        sublabel: "Which table to link to the agent",
        type: "String",
        required: true,
        attributes: { options: allTables.map((t) => t.name) },
      },
      {
        name: "query",
        label: "Query",
        type: "Bool",
        sublabel: "Allow the agent to query from this table",
      },
      {
        name: "insert",
        label: "Insert",
        type: "Bool",
        sublabel: "Allow the agent to insert new rows into this table",
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
        showIf: { query: true },
      },
      {
        name: "add_sys_prompt",
        label: "Additional system prompt",
        type: "String",
      },
    ];
  }

  provideTools() {
    const table = Table.findOne(this.table_name);
    const tools = [];
    let queryProperties = {};
    let required = [];

    table.fields
      .filter((f) => !f.primary_key)
      .forEach((field) => {
        if (field.required && !field.primary_key) required.push(field.name);
        queryProperties[field.name] = {
          description: field.label + " " + field.description || "",
          ...fieldProperties(field),
        };
      });

    if (this.query)
      tools.push({
        type: "function",
        process: async (q) => {
          console.log("Table search", q);

          let rows = [];
          if (q.query?.full_text_search || q.full_text_search) {
            const scState = getState();
            const language = scState.pg_ts_config;
            const use_websearch = scState.getConfig(
              "search_use_websearch",
              false
            );
            rows = await table.getRows({
              _fts: {
                fields: table.fields,
                searchTerm: q.query?.full_text_search || q.full_text_search,
                language,
                use_websearch,
                table: table.name,
                schema: db.isSQLite ? undefined : db.getTenantSchema(),
              },
            });
          } else {
            rows = await table.getRows(q.query || q);
          }
          if (this.hidden_fields) {
            const hidden_fields = this.hidden_fields
              .split(",")
              .map((s) => s.trim());
            rows.forEach((r) => {
              hidden_fields.forEach((k) => {
                delete r[k];
              });
            });
          }

          if (rows.length) return { rows };
          else
            return {
              response: "No rows found",
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
          name: `query_${this.table_name}`,
          description: `Search the ${this.table_name} database table${
            table.description ? ` (${table.description})` : ""
          } by a search phrase matched against all fields in the table with full text search or a more specific query. The retrieved rows will be returned`,
          parameters: {
            type: "object",
            properties: {
              query: {
                anyOf: [
                  {
                    type: "object",
                    description:
                      "Search the table by a phrase matched against any string field",
                    properties: {
                      full_text_search: {
                        type: "string",
                        description: "A phrase to search the table with",
                      },
                    },
                  },
                  {
                    type: "object",
                    description: "Search the table by individual fields",
                    properties: queryProperties,
                  },
                ],
              },
            },
          },
        },
      });

    if (this.insert)
      tools.push({
        type: "function",
        process: async (rows, { req }) => {
          const ids = [];
          if (Array.isArray(rows)) {
            for (const row of rows)
              ids.push(await table.insertRow(row, req?.user));
          } else ids.push(await table.insertRow(rows, req?.user));
          return { created_ids: ids };
        },
        /*renderToolCall({ phrase }, { req }) {
        return div({ class: "border border-primary p-2 m-2" }, phrase);
      },*/
        renderToolResponse: async ({ created_ids }, { req }) => {
          if (created_ids) {
            const view = View.findOne({ name: this.list_view });

            if (view) {
              const viewRes = await view.run(
                { [table.pk_name]: { in: created_ids } },
                { req }
              );
              return viewRes;
            } else return "";
          }
        },
        function: {
          name: `insert_${this.table_name}`,
          description: `Insert rows into the  ${
            this.table_name
          } database table${
            table.description ? ` (${table.description})` : ""
          }`,
          parameters: {
            type: "object",
            required,
            properties: queryProperties,
          },
        },
      });
    return tools;
  }
}

module.exports = TableToSkill;

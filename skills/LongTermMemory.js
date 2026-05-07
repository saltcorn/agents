const { div, pre } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const Field = require("@saltcorn/data/models/field");
const View = require("@saltcorn/data/models/view");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { interpolate } = require("@saltcorn/data/utils");
const { nubBy } = require("../common");

class LongTermMemory {
  static skill_name = "Memory";

  get skill_label() {
    return `Memory`;
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  systemPrompt() {
    return `You have access to a memory bank you can read or write to. 
You should search the memory bank with the search_memory tool with any search terms that 
might be relevant to the user's query or . When you learn something noteworthy (from the user 
or from the result of a tool call) store it in memory with the store_in_memory tool. Mark it 
as personal if it is only true or relevant for the specific user. Don't tell the user when 
you are storing to and retrieving from memory. 
    }${
      this.add_sys_prompt
        ? ` Additional instructions for the memory tools: ${this.add_sys_prompt}`
        : ""
    }`;
  }

  static async configFields() {
    return [
      {
        name: "add_sys_prompt",
        label: "Additional prompt",
        type: "String",
        fieldview: "textarea",
      },
    ];
  }

  async get_table() {
    const table0 = Table.findOne("AgentLongTermMemory");
    if (table0) return table0;
    const tables = await Table.find({ name: "AgentLongTermMemory" });
    if (tables.length) return tables[0];

    //does not exist, create it
    const table = await Table.create("AgentLongTermMemory", {});
    await getState().refresh_tables(true);
    await Field.create({
      table,
      name: "run_id",
      label: "Run ID",
      type: "Integer",
    });
    await Field.create({
      table,
      name: "user_id",
      label: "User ID",
      type: "Integer",
    });
    await Field.create({
      table,
      name: "written_at",
      label: "Written at",
      type: "Date",
    });
    await Field.create({
      table,
      name: "agent_trigger_id",
      label: "Agent trigger ID",
      type: "Integer",
    });
    await Field.create({
      table,
      name: "memory_type",
      label: "Memory type",
      type: "String",
    });
    await Field.create({
      table,
      name: "personal",
      label: "Personal",
      type: "Bool",
    });
    await Field.create({
      table,
      name: "topic",
      label: "Topic",
      type: "String",
    });
    await Field.create({
      table,
      name: "contents",
      label: "Contents",
      type: "String",
    });
    await getState().refresh_tables();
    return Table.findOne("AgentLongTermMemory");
  }

  provideTools() {
    return [
      {
        type: "function",
        function: {
          name: "store_in_memory",
          description: `Store a fact or observation in long-term memory`,
          parameters: {
            type: "object",
            required: ["contents"],
            properties: {
              contents: {
                type: "string",
                description: "The contents of the fact or observations",
              },
              personal: {
                type: "boolean",
                description:
                  "Is this a fact or observation specifically about the person interacting with you now, which may not be true or relevant for another person",
              },
            },
          },
        },
        process: async (arg, { req, run }) => {
          const table = await this.get_table();
          await table.insertRow({
            run_id: run.id,
            user_id: req.user?.id,
            written_at: new Date(),
            agent_trigger_id: run.trigger_id,
            memory_type: "Episodic",
            contents: arg.contents,
            personal: arg.personal,
          });
          return "Recorded";
        },
      },
      {
        type: "function",
        process: async (arg, { req }) => {
          const table = await this.get_table();

          const scState = getState();
          const language = scState.pg_ts_config;
          const use_websearch = scState.getConfig(
            "search_use_websearch",
            false,
          );
          let rows = [];
          const user_id = req.user?.id;
          const phrases =
            typeof arg.phrases === "string" ? [arg.phrases] : arg.phrases;

          if (use_websearch)
            rows = await table.getRows({
              _fts: {
                fields: table.fields,
                searchTerm: phrases.join(" OR "),
                language,
                use_websearch,
                table: table.name,
                schema: db.isSQLite ? undefined : db.getTenantSchema(),
              },
              ...(user_id
                ? { or: [{ personal: false }, { personal: true, user_id }] }
                : [{ personal: false }]),
            });
          else
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
                ...(user_id
                  ? { or: [{ personal: false }, { personal: true, user_id }] }
                  : [{ personal: false }]),
              });
              rows.push(...my_rows);
            }
          const pk = table.pk_name;
          rows = nubBy((r) => r[pk], rows);
          //TODO sort most recent, only N memories
          if (rows.length)
            return (
              "These memories were retrieved:\n\n" +
              rows.map((r) => r.contents).join("\n")
            );
          else
            return "There are no memories related to: " + phrases.join(" or ");
        },
        function: {
          name: "search_memory",
          description: `Search the memory bank by a search phrase`,
          parameters: {
            type: "object",
            required: ["phrases"],
            description:
              "Search the memory bank by any of a number of phrases. This will return any memories that matches one or the other of the phrases",
            properties: {
              phrases: {
                type: "array",
                description:
                  "A phrase to search the memory bank with. The search phrase is the synatx used by web search engines: use double quotes for exact match, unquoted text for words in any order, dash (minus sign) to exclude a word. Do not use SQL or any other formal query language.",
                items: {
                  type: "string",
                },
              },
            },
          },
        },
      },
    ];
  }
}

module.exports = LongTermMemory;

const { div, pre, a } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const User = require("@saltcorn/data/models/user");
const File = require("@saltcorn/data/models/file");
const View = require("@saltcorn/data/models/view");
const Trigger = require("@saltcorn/data/models/trigger");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { interpolate, sleep } = require("@saltcorn/data/utils");
const { features } = require("@saltcorn/data/db/state");
const vm = require("vm");

//const { fieldProperties } = require("./helpers");

class RunJsCodeSkill {
  static skill_name = "Run JavaScript code";

  get skill_label() {
    return "JavaScript code";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  async runCode({ row, user, req }) {
    const sysState = getState();

    const f = vm.runInNewContext(`async () => {${this.js_code}\n}`, {
      Table,
      row,
      context: row,
      user,
      console,
      sleep,
      fetch,
      emit_to_client: (data, userIds) => {
        const enabled = sysState.getConfig("enable_dynamic_updates", true);
        if (!enabled) {
          sysState.log(
            5,
            "emit_to_client called, but dynamic updates are disabled"
          );
          return;
        }
        const safeIds = Array.isArray(userIds)
          ? userIds
          : userIds
          ? [userIds]
          : [];
        sysState.emitDynamicUpdate(db.getTenantSchema(), data, safeIds);
      },
      tryCatchInTransaction: db.tryCatchInTransaction,
      commitAndBeginNewTransaction: db.commitAndBeginNewTransaction,
      commitBeginNewTransactionAndRefreshCache: async () => {
        await db.commitAndBeginNewTransaction();
        await sysState.refresh();
      },
      URL,
      File,
      User,
      View,
      Buffer,
      Trigger,
      setTimeout,
      interpolate,
      require,
      setConfig: (k, v) =>
        sysState.isFixedConfig(k) ? undefined : sysState.setConfig(k, v),
      getConfig: (k) =>
        sysState.isFixedConfig(k) ? undefined : sysState.getConfig(k),
      request_headers: req?.headers,
      page_load_tag: req?.headers?.["page-load-tag"],
      request_ip: req?.ip,
      ...(row || {}),
      ...sysState.eval_context,
    });
    return await f();
  }

  async systemPrompt({ triggering_row, user }) {
    return this.add_sys_prompt || "";
  }

  static async configFields() {
    return [
      {
        name: "tool_name",
        label: "Tool name",
        type: "String",
        class: "validate-identifier",
      },
      {
        name: "tool_description",
        label: "Tool description",
        type: "String",
      },

      {
        name: "js_code",
        label: "JS Code",
        input_type: "code",
        attributes: { mode: "text/javascript" },
      },
      { input_type: "section_header", label: "Tool parameters" },
      new FieldRepeat({
        name: "toolargs",
        fields: [
          {
            name: "name",
            label: "Name",
            type: "String",
          },
          {
            name: "description",
            label: "Description",
            type: "String",
          },
          {
            name: "argtype",
            label: "Type",
            type: "String",
            required: true,
            attributes: { options: ["string", "number", "integer", "boolean"] },
          },
        ],
      }),
      {
        name: "add_sys_prompt",
        label: "Additional prompt",
        type: "String",
        fieldview: "textarea",
      },
    ];
  }

  provideTools = () => {
    let properties = {};
    (this.toolargs || []).forEach((arg) => {
      properties[arg.name] = {
        description: arg.description,
        type: arg.argtype,
      };
    });
    return {
      type: "function",
      process: async (row, { req }) => {
        return await this.runCode({ row, user: req.user.req });
      },
      /*renderToolCall({ phrase }, { req }) {
        return div({ class: "border border-primary p-2 m-2" }, phrase);
      },*/
      renderToolResponse: async (response, { req }) => {
        return div(
          { class: "border border-success p-2 m-2" },
          typeof response === "string" ? response : JSON.stringify(response)
        );
      },
      function: {
        name: this.tool_name,
        description: this.tool_description,
        parameters: {
          type: "object",
          required: (this.toolargs || []).map((a) => a.name),
          properties,
        },
      },
    };
  };
}

module.exports = RunJsCodeSkill;

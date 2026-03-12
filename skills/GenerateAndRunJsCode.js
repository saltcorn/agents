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
const { button } = require("@saltcorn/markup/tags");
const { validID } = require("@saltcorn/markup/layout_utils");

const vm = require("vm");

//const { fieldProperties } = require("./helpers");

class GenerateAndRunJsCodeSkill {
  static skill_name = "Generate and run JavaScript code";

  get skill_label() {
    return "Generate and run JavaScript code";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
    if (this.mode === "Button")
      this.skillid = `jsbtn${validID(this.button_label || "jscodebtn")}`;
  }

  async runCode(code, { user, req, ...rest }) {
    const sysState = getState();

    const f = vm.runInNewContext(`async () => {${code}\n}`, {
      Table,
      user,
      console,
      sleep,
      fetch,
      emit_to_client: (data, userIds) => {
        const enabled = sysState.getConfig("enable_dynamic_updates", true);
        if (!enabled) {
          sysState.log(
            5,
            "emit_to_client called, but dynamic updates are disabled",
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
      ...sysState.eval_context,
      ...rest,
    });
    return await f();
  }

  async systemPrompt({ triggering_row, user }) {
    return this.add_sys_prompt || "";
  }

  async skillRoute({ run, triggering_row, req }) {
    return await this.runCode({ row: triggering_row, run, user: req.user });
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
        name: "code_description",
        label: "Code description",
        type: "String",
        fieldview: "textarea",
      },
      {
        name: "add_sys_prompt",
        label: "Additional system prompt",
        type: "String",
        fieldview: "textarea",
      },
    ];
  }

  provideTools = () => {
    return {
      type: "function",
      process: async (row, { req }) => {
        return "Code generation tool activated";
        //return await this.runCode({ row, user: req.user });
      },
      /*renderToolCall({ phrase }, { req }) {
        return div({ class: "border border-primary p-2 m-2" }, phrase);
      },*/
      postProcess: async ({ tool_call, req, generate, ...rest }) => {
        //console.log("postprocess args", { tool_call, ...rest });

        const str = await generate(
          `Now generate the JavaScript code required by the user. Some more information:
          
${this.code_description}
         
The code you write can use await at the top level, and should return 
(at the top level) a string with the response which will be shown to the user.`,
        );
        //console.log("gen answer", str);

        const js_code = str.includes("```javascript")
          ? str.split("```javascript")[1].split("```")[0]
          : str;

        const res = await this.runCode(js_code, { user: req.user });
        //console.log("code response", res);

        return {
          stop: true,
          add_response: res,
        };
      },
      function: {
        name: this.tool_name,
        description: this.tool_description,
        parameters: {
          type: "object",
          properties: {},
        },
      },
    };
  };
}

module.exports = GenerateAndRunJsCodeSkill;

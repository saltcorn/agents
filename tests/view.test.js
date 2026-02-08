const { getState } = require("@saltcorn/data/db/state");
const View = require("@saltcorn/data/models/view");
const Trigger = require("@saltcorn/data/models/trigger");
const Table = require("@saltcorn/data/models/table");
const Plugin = require("@saltcorn/data/models/plugin");

const { mockReqRes } = require("@saltcorn/data/tests/mocks");
const { afterAll, beforeAll, describe, it, expect } = require("@jest/globals");

/* 
 
 RUN WITH:
  saltcorn dev:plugin-test -d ~/agents -o ~/large-language-model/
 
 */

afterAll(require("@saltcorn/data/db").close);
beforeAll(async () => {
  await require("@saltcorn/data/db/reset_schema")();
  await require("@saltcorn/data/db/fixtures")();

  getState().registerPlugin("base", require("@saltcorn/data/base-plugin"));
});

jest.setTimeout(30000);

for (const nameconfig of require("./configs")) {
  const { name, ...config } = nameconfig;
  describe("agent view with " + name, () => {
    beforeAll(async () => {
      getState().registerPlugin(
        "@saltcorn/large-language-model",
        require("@saltcorn/large-language-model"),
        config,
      );
      getState().registerPlugin("@saltcorn/agents", require(".."));
    });

    it("creates action and view", async () => {
      const trigger = await Trigger.create({
        name: "AgentTest",
        description: "",
        action: "Agent",
        when_trigger: "Never",
        configuration: require("./agentcfg"),
      });
      
      await getState().refresh_triggers(false)
      const view = await View.create({
        name: "AgentView",
        description: "",
        viewtemplate: "Agent Chat",
        configuration: {
          stream: true,
          viewname: "AgentView",
          action_id: trigger.id,
          explainer: "",
          placeholder: "How can I help you?",
          image_base64: true,
          image_upload: true,
          exttable_name: null,
          show_prev_runs: false,
          prev_runs_closed: false,
          display_tool_output: true,
        },
        min_role: 1,
        table: "books",
        slug: null,
        attributes: {
          no_menu: false,
          page_title: "",
          popup_title: "",
          popup_width: 800,
          popup_link_out: true,
          popup_minwidth: null,
          page_description: "",
          popup_save_indicator: false,
        },
        default_render_page: "",
        exttable_name: null,
      });
      await getState().refresh_views(false)

      const result = await view.run({}, mockReqRes);  
      expect(result).toContain("Pirate")
    });
  });
  break; //only need to test one config iteration
}

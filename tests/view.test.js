const { getState } = require("@saltcorn/data/db/state");
const View = require("@saltcorn/data/models/view");
const Trigger = require("@saltcorn/data/models/trigger");
const Table = require("@saltcorn/data/models/table");
const Plugin = require("@saltcorn/data/models/plugin");
const WorkflowRun = require("@saltcorn/data/models/workflow_run");
const User = require("@saltcorn/data/models/user");

const { mockReqRes } = require("@saltcorn/data/tests/mocks");
const { afterAll, beforeAll, describe, it, expect, jest } = require("@saltcorn/db-common/test_expect");

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
        configuration: require("./agentcfg").agent1,
      });

      await getState().refresh_triggers(false);
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
      await getState().refresh_views(false);

      const result = await view.run({}, mockReqRes);
      expect(result).toContain(">Pirate<");
    });
  });
  break; //only need to test one config iteration
}

// cancel/skillroute/execute_user_action didn't check run.started_by, unlike
// delprevrun/renameprevrun/share_chat. Called directly here - no LLM needed.
describe("agent view route ownership checks", () => {
  const { routes } = require("../agent-view");
  const other_user_id = 999999; // never persisted, only compared - no real user needed
  let owner_id, trigger;

  beforeAll(async () => {
    const owner = await User.findOne({ email: "staff@foo.com" });
    owner_id = owner.id;
    trigger = await Trigger.create({
      name: "OwnershipTestTrigger",
      action: "Agent",
      when_trigger: "Never",
      configuration: {},
    });
  });

  const mkRun = async (extra) =>
    await WorkflowRun.create({
      trigger_id: trigger.id,
      context: {},
      started_by: owner_id,
      status: "Running",
      ...extra,
    });

  it("cancel blocks a non-owner and allows the owner", async () => {
    const run = await mkRun();
    await routes.cancel(
      null,
      "AgentView",
      {},
      { run_id: run.id },
      { req: { user: { id: other_user_id } }, res: {} }
    );
    expect((await WorkflowRun.findOne({ id: run.id })).status).toBe(
      "Running"
    );

    await routes.cancel(
      null,
      "AgentView",
      {},
      { run_id: run.id },
      { req: { user: { id: owner_id } }, res: {} }
    );
    expect((await WorkflowRun.findOne({ id: run.id })).status).toBe(
      "Cancel"
    );
  });

  it("cancel allows a non-owner when the view is configured as shared", async () => {
    const run = await mkRun();
    await routes.cancel(
      null,
      "AgentView",
      { shared: true },
      { run_id: run.id },
      { req: { user: { id: other_user_id } }, res: {} }
    );
    expect((await WorkflowRun.findOne({ id: run.id })).status).toBe(
      "Cancel"
    );
  });

  // action.configuration lacks `skills` on purpose: reaching get_skill_instances
  // throws, so a throw proves the owner got past the ownership check.
  it("skillroute blocks a non-owner before touching the skill config", async () => {
    const run = await mkRun();
    const config = { agent_action: { configuration: {} } };
    await expect(
      routes.skillroute(
        null,
        "AgentView",
        config,
        { run_id: run.id, skillid: "x" },
        { req: { user: { id: other_user_id } }, res: {} }
      )
    ).resolves.toBe(undefined);
  });

  it("skillroute proceeds past the ownership check for the owner", async () => {
    const run = await mkRun();
    const config = { agent_action: { configuration: {} } };
    await expect(
      routes.skillroute(
        null,
        "AgentView",
        config,
        { run_id: run.id, skillid: "x" },
        { req: { user: { id: owner_id } }, res: {} }
      )
    ).rejects.toThrow();
  });

  it("execute_user_action blocks a non-owner before touching the skill config", async () => {
    const run = await mkRun({ context: { user_actions: [] } });
    const config = { agent_action: { configuration: {} } };
    await expect(
      routes.execute_user_action(
        null,
        "AgentView",
        config,
        { run_id: run.id, rndid: "r1", uaname: "ua" },
        { req: { user: { id: other_user_id } }, res: {} }
      )
    ).resolves.toBe(undefined);
  });

  it("execute_user_action proceeds past the ownership check for the owner", async () => {
    const run = await mkRun({ context: { user_actions: [] } });
    const config = { agent_action: { configuration: {} } };
    await expect(
      routes.execute_user_action(
        null,
        "AgentView",
        config,
        { run_id: run.id, rndid: "r1", uaname: "ua" },
        { req: { user: { id: owner_id } }, res: {} }
      )
    ).rejects.toThrow();
  });
});

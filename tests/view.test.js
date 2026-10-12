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
  const agentView = require("../agent-view")({});
  const { routes } = agentView;
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

  const anon = (run_ids) => ({
    __: (s) => s,
    session: run_ids ? { agent_run_ids: run_ids } : {},
  });
  const interact = (config, body, req) =>
    routes.interact(null, "AgentView", config, body, { req, res: {} });

  it("interact refuses a run the user did not start", async () => {
    const run = await mkRun();
    const res = await interact(
      { action_id: trigger.id },
      { run_id: run.id, userinput: "hi" },
      { __: (s) => s, user: { id: other_user_id } },
    );
    expect(res.json.error).toBe("Not authorized");
    expect((await WorkflowRun.findOne({ id: run.id })).context).toEqual({});
  });

  it("interact refuses the holder of a share link", async () => {
    const run = await mkRun({ context: { share_token: "tok" } });
    for (const req of [anon(), { __: (s) => s, user: { id: other_user_id } }]) {
      const res = await interact(
        { action_id: trigger.id },
        { run_id: run.id, userinput: "hi", share_token: "tok" },
        req,
      );
      expect(res.json.error).toBe("Not authorized");
    }
  });

  it("interact refuses a run of another agent, even on a shared view", async () => {
    const run = await mkRun();
    const res = await interact(
      { action_id: trigger.id + 1000, shared: true },
      { run_id: run.id, userinput: "hi" },
      { __: (s) => s, user: { id: owner_id } },
    );
    expect(res.json.error).toBe("Not authorized");
  });

  it("anonymous runs belong to the session that started them", async () => {
    const run = await mkRun({ started_by: null });
    const cancel = (req) =>
      routes.cancel(
        null,
        "AgentView",
        {},
        { run_id: run.id },
        { req, res: {} },
      );
    await cancel(anon());
    await cancel(anon([run.id + 1]));
    expect((await WorkflowRun.findOne({ id: run.id })).status).toBe("Running");
    await cancel(anon([run.id]));
    expect((await WorkflowRun.findOne({ id: run.id })).status).toBe("Cancel");
  });

  it("share_chat gives the token to the owner only", async () => {
    const run = await mkRun({ context: { share_token: "tok" } });
    const share = (req) =>
      routes.share_chat(
        null,
        "AgentView",
        {},
        { run_id: run.id },
        { req, res: {} },
      );
    expect(
      (await share({ __: (s) => s, user: { id: other_user_id } })).json
        .share_token,
    ).toBe(undefined);
    expect(
      (await share({ __: (s) => s, user: { id: owner_id } })).json.share_token,
    ).toBe("tok");
  });

  it("share_chat creates a long random token", async () => {
    const run = await mkRun();
    const res = await routes.share_chat(
      null,
      "AgentView",
      {},
      { run_id: run.id },
      { req: { __: (s) => s, user: { id: owner_id } }, res: {} },
    );
    expect(res.json.share_token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("delprevrun ignores unknown runs and runs of another agent", async () => {
    const run = await mkRun();
    const del = (config, run_id) =>
      routes.delprevrun(
        null,
        "AgentView",
        config,
        { run_id },
        {
          req: { user: { id: owner_id } },
          res: {},
        },
      );
    await del({}, 99999999);
    await del({ action_id: trigger.id + 1000 }, run.id);
    expect(await WorkflowRun.findOne({ id: run.id })).toBeTruthy();
    await del({ action_id: trigger.id }, run.id);
    expect(await WorkflowRun.findOne({ id: run.id })).toBeFalsy();
  });

  // rendering the stored AgentView: a share link shows the chat without the
  // input form, and a bare run id shows nothing of it
  it("run() shows a shared chat read-only", async () => {
    const view = View.findOne({ name: "AgentView" });
    const chat = await WorkflowRun.create({
      trigger_id: view.configuration.action_id,
      started_by: owner_id,
      status: "Finished",
      context: {
        share_token: "tok",
        interactions: [{ role: "user", content: "secretword" }],
      },
    });
    // the view template directly: AgentView itself is for admins only
    const render = (state, req) =>
      agentView.run(
        view.table_id,
        view.name,
        view.configuration,
        { run_id: chat.id, ...state },
        { res: mockReqRes.res, req: { ...mockReqRes.req, ...req } },
      );
    const anonReq = { user: undefined, session: {} };

    const owner = await render({}, { user: { id: owner_id, role_id: 40 } });
    expect(owner).toContain("secretword");
    expect(owner).toContain('name="userinput"');

    for (const req of [anonReq, { user: { id: other_user_id, role_id: 80 } }]) {
      const linked = await render({ share_token: "tok" }, req);
      expect(linked).toContain("secretword");
      expect(linked).not.toContain('name="userinput"');

      const guessed = await render({}, req);
      expect(guessed).not.toContain("secretword");
    }
  });

  it("run() lets an anonymous visitor back into the chat they started", async () => {
    const view = View.findOne({ name: "AgentView" });
    const mk = () =>
      WorkflowRun.create({
        trigger_id: view.configuration.action_id,
        started_by: null,
        status: "Finished",
        context: { interactions: [{ role: "user", content: "secretword" }] },
      });
    const mine = await mk();
    const theirs = await mk();
    const render = (run_id) =>
      agentView.run(
        view.table_id,
        view.name,
        view.configuration,
        { run_id },
        {
          res: mockReqRes.res,
          req: {
            ...mockReqRes.req,
            user: undefined,
            session: { agent_run_ids: [mine.id] },
          },
        },
      );
    const own = await render(mine.id);
    expect(own).toContain("secretword");
    expect(own).toContain('name="userinput"');
    expect(await render(theirs.id)).not.toContain("secretword");
  });
});

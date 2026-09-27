const Table = require("@saltcorn/data/models/table");
const Field = require("@saltcorn/data/models/field");
const Trigger = require("@saltcorn/data/models/trigger");
const { getState } = require("@saltcorn/data/db/state");

const RUN_TABLE = "agentsAuditTrailRun";
const MSG_TABLE = "agentsAuditTrailMsg";

// run_id is empty for agent_generate calls with run_id: null, which are never
// saved as a workflow run. action_id is empty for agents configured inline in
// a view (the copilot) rather than as a trigger.
const runFields = [
  { name: "run_id", label: "Run ID", type: "Integer" },
  { name: "action_name", label: "Action name", type: "String" },
  { name: "action_id", label: "Action ID", type: "Integer" },
  { name: "run_by", label: "Run by", type: "Integer" },
  { name: "created_at", label: "Created at", type: "Date", required: true },
];

// html is empty for an answer that is not shown, for instance a tool call with
// nothing to render
const msgFields = [
  {
    name: "audit_run",
    label: "Audit run",
    type: `Key to ${RUN_TABLE}`,
    required: true,
  },
  { name: "created_at", label: "created at", type: "Date", required: true },
  { name: "error", label: "Error", type: "String" },
  { name: "role", label: "Role", type: "String" },
  { name: "interaction", label: "interaction", type: "JSON", required: true },
  { name: "html", label: "HTML", type: "HTML" },
];

// Fields are created one by one if missing, so that a table left incomplete, or
// created by an earlier version of this module, is brought up to date
const ensureTable = async (name, fields) => {
  let table = Table.findOne({ name });
  let changed = false;
  if (!table) {
    table = await Table.create(name, { min_role_read: 1, min_role_write: 1 });
    changed = true;
  }
  for (const f of fields) {
    if (table.getField(f.name)) continue;
    await Field.create({ table, ...f });
    changed = true;
  }
  return changed;
};

// the run table has to be in the state before the message table's key to it
// can be created
const getAuditTrailTables = async () => {
  if (await ensureTable(RUN_TABLE, runFields))
    await getState().refresh_tables();
  if (await ensureTable(MSG_TABLE, msgFields))
    await getState().refresh_tables();
  return {
    runTable: Table.findOne({ name: RUN_TABLE }),
    msgTable: Table.findOne({ name: MSG_TABLE }),
  };
};

// runs that are not saved have no id to find their audit run by, so it is
// kept on the run object instead
const unsavedAuditRuns = new WeakMap();

const insertAuditRun = async (runTable, { run, user, action }) => {
  const action_id = action?.id || run.trigger_id || null;
  let action_name = action?.name;
  if (!action_name && action_id)
    action_name = Trigger.findOne({ id: action_id })?.name;
  const id = await runTable.insertRow({
    run_id: run.id || null,
    action_name: action_name || null,
    action_id,
    run_by: user?.id || run.started_by || null,
    created_at: new Date(),
  });
  if (!run.id) unsavedAuditRuns.set(run, id);
  return id;
};

const findAuditRun = async (runTable, run) => {
  if (!run.id) return unsavedAuditRuns.get(run);
  const row = await runTable.getRow({ run_id: run.id });
  return row?.id;
};

// The audit trail must never stop an agent from running, so a failure to
// write it is logged rather than thrown
const safely = (what, f) => async (opts) => {
  if (!opts.modcfg?.audit_trail || !opts.run) return;
  try {
    return await f(opts);
  } catch (e) {
    getState().log(2, `Agents audit trail: ${what} failed: ${e?.message || e}`);
  }
};

// Called when a workflow run is created for an agent
const createAuditTrailRun = safely(
  "creating run",
  async ({ run, user, action }) => {
    const { runTable } = await getAuditTrailTables();
    return await insertAuditRun(runTable, { run, user, action });
  },
);

// Called for every message from the user and every reply from the LLM. The
// audit run is created here if there is none yet, for runs started before the
// audit trail was enabled.
const logToAuditTrailTable = safely(
  "logging message",
  async ({ run, user, action, role, interaction, html, error }) => {
    const { runTable, msgTable } = await getAuditTrailTables();
    const audit_run =
      (await findAuditRun(runTable, run)) ||
      (await insertAuditRun(runTable, { run, user, action }));
    await msgTable.insertRow({
      audit_run,
      created_at: new Date(),
      role,
      interaction,
      html: html || null,
      error: error || null,
    });
  },
);

module.exports = {
  getAuditTrailTables,
  createAuditTrailRun,
  logToAuditTrailTable,
};

const Table = require("@saltcorn/data/models/table");

const getAuditTrailTables = async () => {
    let table = await Table.findOne({ name: "agentsAuditTrailRun" });
    if(!table) {
        table = await Table.create("agentsAuditTrailRun", {
            min_role_read: 1,
            min_role_write: 1,
        });

        //fields: run_id, action_name, action_id, html_interactions, run_by, updated_at, error
        await Field.create({
            table,
            name: "run_id",
            label: "Run ID",
            type: "Integer",
            required: true,
        });
        await Field.create({
            table,
            name: "action_name",
            label: "Action name",
            type: "String",
            required: true,
        });
        await Field.create({
            table,
            name: "action_id",
            label: "Action ID",
            type: "Integer",
            required: true,
        });
        await Field.create({
            table,
            name: "run_by",
            label: "Run by",
            type: "Integer",
        });
        await Field.create({
            table,
            name: "created_at",
            label: "Created at",
            type: "Date",
            required: true,
        });
    }
    let tableMsg = await Table.findOne({ name: "agentsAuditTrailMsg" });
    if(!tableMsg) {
         table = await Table.create("agentsAuditTrailMsg", {
            min_role_read: 1,
            min_role_write: 1,
        });
        await Field.create({
            table: tableMsg,
            name: "created_at",
            label: "created at",
            type: "Date",
            required: true,
        });
        await Field.create({
            table: tableMsg,
            name: "error",
            label: "Error",
            type: "String",
        });
        await Field.create({
            table: tableMsg,
            name: "role",
            label: "Role",
            type: "String",
        });
        await Field.create({
            table: tableMsg,
            name: "interaction",
            label: "interaction",
            type: "JSON",
            required: true,
        });
        await Field.create({
            table: tableMsg,
            name: "html",
            label: "HTML",
            type: "HTML",
            required: true,
        });
    }
    const { getState } = require("@saltcorn/data/db/state");
    await getState().refresh_tables();
    return {runTable: table, msgTable: tableMsg};
}

const logToAuditTrailTable = async({run, user, action}) => {
   // TODO
}

module.exports = { getAuditTrailTables, logToAuditTrailTable }
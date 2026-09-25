const Table = require("@saltcorn/data/models/table");

const getAuditTrailTable = async () => {
    let table = await Table.findOne({ name: "Agents audit trail" });
    if(table) return table
    
    table = await Table.create("Agents audit trail", {
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
        name: "updated_at",
        label: "Updated at",
        type: "Date",
        required: true,
    });
    await Field.create({
        table,
        name: "error",
        label: "Error",
        type: "String",
    });
     await Field.create({
        table,
        name: "interactions",
        label: "interactions",
        type: "JSON",
        required: true,
    });
    const { getState } = require("@saltcorn/data/db/state");
    await getState().refresh_tables();
    return table;
}

const logToAuditTrailTable = async({run, user, action}) => {
    const table = await getAuditTrailTable()
    const existing = await table.getRow({run_id: run.id})
    if(existing) 
        await table.updateRow({
            updated_at: new Date(),
            error: run.error,
            interactions: run.context.html_interactions,
            run_by: user.id
        }, existing.id)
    else
        await table.insertRow({
            run_id: run.id, 
            updated_at: new Date(),
            error: run.error,
            interactions: run.context.html_interactions,
            action_name: action.name,
            action_id: action.id,
            run_by: user.id
        })
}

module.exports = { getAuditTrailTable, logToAuditTrailTable }
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const { p } = require("@saltcorn/markup/tags");
const { get_skills, process_interaction, wrapSegment } = require("./common");
const { applyAsync } = require("@saltcorn/data/utils");
const WorkflowRun = require("@saltcorn/data/models/workflow_run");
const { interpolate, escapeHtml } = require("@saltcorn/data/utils");
const { getState } = require("@saltcorn/data/db/state");

module.exports = {
  disableInBuilder: true,
  disableInList: true,
  disableInWorkflow: true,
  configFields: async ({ table, mode }) => {
    const skills = get_skills();
    const skills_fields = [];
    for (const skill of skills) {
      if (skill.configFields) {
        const fields = await applyAsync(skill.configFields, undefined);
        for (const field of fields) {
          if (!field.showIf) field.showIf = {};
          field.showIf.skill_type = skill.skill_name;
          skills_fields.push(field);
        }
      }
    }
    const llm_cfg_fun = getState().functions.llm_get_configuration;
    const alt_config_options = llm_cfg_fun
      ? llm_cfg_fun.run().alt_config_names || []
      : [];
    return [
      ...(table
        ? [
            {
              name: "prompt",
              label: "Prompt",
              sublabel:
                "When triggered from table event or table view button. Use handlebars <code>{{}}</code> to access table fields. Ignored if run in Agent Chat view.",
              type: "String",
            },
            {
              name: "run_id_field",
              type: "String",
              label: "Run ID field",
              sublabel:
                "Set this field to the run ID, when triggered from table event or table view button. Ignored if run in Agent Chat view.",
              attributes: {
                options: table.fields
                  .filter((f) => f.type?.name === "Integer" && !f.primary_key)
                  .map((f) => f.name),
              },
            },
          ]
        : []),
      {
        name: "sys_prompt",
        label: "System prompt",
        sublabel:
          "Additional information for the system prompt. Use interpolations <code>{{ }}</code> to access triggering row variables or user",
        type: "String",
        fieldview: "textarea",
      },
      ...(alt_config_options.length
        ? [
            {
              name: "alt_config",
              label: "Alternative configuration",
              sublabel: "Use this configuration for LLM interactions",
              type: "String",
              attributes: { options: alt_config_options },
            },
          ]
        : []),
      {
        name: "model",
        label: "Model",
        sublabel: "Override default model name",
        type: "String",
      },
      new FieldRepeat({
        name: "skills",
        label: "Skills",
        fields: [
          {
            name: "skill_type",
            label: "Type",
            type: "String",
            required: true,
            attributes: { options: skills.map((s) => s.skill_name) },
          },
          ...skills_fields,
        ],
      }),
    ];
  },
  run: async ({
    configuration,
    user,
    row,
    trigger_id,
    table,
    run_id,
    req,
    is_sub_agent,
    agent_view_config,
    dyn_updates,
    agent_label,
    ...rest
  }) => {
    const userinput = interpolate(configuration.prompt, row, user);

    const run =
      rest.run ||
      (run_id
        ? await WorkflowRun.findOne({ id: run_id })
        : await WorkflowRun.create({
            status: "Running",
            started_by: user?.id,
            trigger_id: trigger_id || undefined,
            context: {
              implemented_fcall_ids: [],
              interactions: [],
              html_interactions: [],
              funcalls: {},
            },
          }));

    if (!rest.run && !run_id && table && configuration.run_id_field) {
      await table.updateRow(
        { [configuration.run_id_field]: run.id },
        row[table.pk_name],
      );
    }
    let use_agent_view_config = agent_view_config;
    if (!use_agent_view_config) {
      const agent_views = await View.find({ viewtemplate: "Agent Chat" });
      const agent_view = agent_views.find(
        (v) => v?.configuration?.action_id == trigger_id,
      );
      if (agent_view)
        use_agent_view_config = { ...agent_view.configuration, stream: false };
    }
    run.context.interactions.push({ role: "user", content: userinput });
    run.context.html_interactions.push(
      wrapSegment(
        p(escapeHtml(userinput)),
        "You",
        true,
        use_agent_view_config?.layout,
        req?.user,
      ),
    );   

    return await process_interaction(
      run,
      configuration,
      req,
      agent_label || undefined,
      [],
      row,
      use_agent_view_config || { stream: false },
      dyn_updates,
      is_sub_agent,
    );
  },
};

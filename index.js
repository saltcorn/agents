const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { features } = require("@saltcorn/data/db/state");
const {
  get_skills,
  getCompletionArguments,
  process_interaction,
} = require("./common");
const { applyAsync } = require("@saltcorn/data/utils");
const WorkflowRun = require("@saltcorn/data/models/workflow_run");
const { interpolate } = require("@saltcorn/data/utils");
const { getState } = require("@saltcorn/data/db/state");

module.exports = {
  sc_plugin_api_version: 1,
  dependencies: ["@saltcorn/large-language-model"],
  viewtemplates: [require("./agent-view")],
  actions: {
    Agent: {
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
        return [
          ...(table
            ? [
                {
                  name: "prompt",
                  label: "Prompt",
                  sublabel:
                    "When triggered from table event or table view button. Use handlebars <code>{{}}</code> to access table fields. Ignored if run in Agent Chat view.",
                  type: "String",
                  required: true,
                  attributes: { options: table.fields.map((f) => f.name) },
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
      run: async ({ configuration, user, row, trigger_id, req, ...rest }) => {
        const userinput = interpolate(configuration.prompt, row, user);
        const run = await WorkflowRun.create({
          status: "Running",
          started_by: user?.id,
          trigger_id: trigger_id || undefined,
          context: {
            implemented_fcall_ids: [],
            interactions: [{ role: "user", content: userinput }],
            funcalls: {},
          },
        });
        return await process_interaction(
          run,
          configuration,
          req,
          undefined,
          [],
          row
        );
      },
    },
  },
};

/* 
TODO

-embedding retrieval list view
-optional user confirm: action, insert
-Preload data
-sql access
-memory

*/

const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { features } = require("@saltcorn/data/db/state");
const { get_skills } = require("./common");
const { applyAsync } = require("@saltcorn/data/utils");
module.exports = {
  sc_plugin_api_version: 1,
  dependencies: ["@saltcorn/large-language-model"],
  actions: {
    agent: {
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
                  name: "prompt_field",
                  label: "Prompt field",
                  sublabel:
                    "When triggered from table event or table view button",
                  type: "String",
                  required: true,
                  attributes: { options: table.fields.map((f) => f.name) },
                },
              ]
            : []),
          {
            name: "sys_prompt",
            label: "System prompt",
            sublabel: "Additional information for the system prompt",
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
      run: async ({
        configuration: {
          row_expr,
          table_src,
          table_dest,
          pk_field,
          delete_rows,
          match_field_names,
          where,
        },
        user,
        ...rest
      }) => {},
    },
  },
};

const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { features } = require("@saltcorn/data/db/state");
const { get_skills } = require("./common");

module.exports = {
  sc_plugin_api_version: 1,
  dependencies: ["@saltcorn/large-language-model"],
  actions: {
    agent: {
      configFields: ({ table, mode }) => {
        const skills = get_skills();
        return [
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
            ],
          }),
        ];
      },
    },
  },
};

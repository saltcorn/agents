const { getState } = require("@saltcorn/data/db/state");
const View = require("@saltcorn/data/models/view");
const Table = require("@saltcorn/data/models/table");
const Plugin = require("@saltcorn/data/models/plugin");

const { mockReqRes } = require("@saltcorn/data/tests/mocks");
const { afterAll, beforeAll, describe, it, expect } = require("@jest/globals");

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
    it("has config fields", async () => {
      const action = require("../action");
      const cfgFldsNoTable = await action.configFields({});
      expect(cfgFldsNoTable.length).toBe(3);
      const cfgFldsWithTable = await action.configFields({
        table: Table.findOne("books"),
      });
      expect(cfgFldsWithTable.length).toBe(4);
    });

    it("generates text", async () => {
      const action = require("../action");
      const user = { id: 1, role_id: 1 };

      const result = await action.run({
        row: { theprompt: "What is the word of the day?" },
        configuration: {
          model: "",
          prompt: "theprompt",
          skills: [
            {
              mode: "Tool",
              js_code: 'return "Strawberry"',
              toolargs: [
                {
                  name: "",
                  argtype: "string",
                  description: "",
                },
              ],
              tool_name: "word_of_the_day",
              skill_type: "Run JavaScript code",
              add_sys_prompt: "",
              tool_description: "return the word of the day",
            },
            {
              skill_type: "Prompt picker",
              placeholder: "Pick voice",
              options_array: [
                {
                  promptpicker_label: "Pirate",
                  promptpicker_sysprompt: "Speak like a pirate",
                },
                {
                  promptpicker_label: "Lawyer",
                  promptpicker_sysprompt: "Speak like a lawyer",
                },
              ],
            },
          ],
          sys_prompt: "",
        },
        user,
        req: { user },
      });
      expect(result.json.response).toContain("trawberry");
    });
  });
}

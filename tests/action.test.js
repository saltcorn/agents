const { getState } = require("@saltcorn/data/db/state");
const View = require("@saltcorn/data/models/view");
const Table = require("@saltcorn/data/models/table");
const Plugin = require("@saltcorn/data/models/plugin");

const { mockReqRes } = require("@saltcorn/data/tests/mocks");
const { afterAll, beforeAll, describe, it, expect } = require("@jest/globals");

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
  describe("agent action with " + name, () => {
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
        configuration: require("./agentcfg"),
        user,
        req: { user },
      });
      expect(result.json.response).toContain("trawberry");
    });
  });
}

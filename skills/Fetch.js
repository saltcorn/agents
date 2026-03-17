const { div, pre, a } = require("@saltcorn/markup/tags");
const Workflow = require("@saltcorn/data/models/workflow");
const Form = require("@saltcorn/data/models/form");
const Table = require("@saltcorn/data/models/table");
const User = require("@saltcorn/data/models/user");
const File = require("@saltcorn/data/models/file");
const View = require("@saltcorn/data/models/view");
const Trigger = require("@saltcorn/data/models/trigger");
const FieldRepeat = require("@saltcorn/data/models/fieldrepeat");
const { getState } = require("@saltcorn/data/db/state");
const db = require("@saltcorn/data/db");
const { eval_expression } = require("@saltcorn/data/models/expression");
const { interpolate, sleep } = require("@saltcorn/data/utils");
const { features } = require("@saltcorn/data/db/state");
const { button } = require("@saltcorn/markup/tags");
const { validID } = require("@saltcorn/markup/layout_utils");

const vm = require("vm");

//const { fieldProperties } = require("./helpers");

class FetchSkill {
  static skill_name = "Fetch";

  get skill_label() {
    return "Fetch";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    return [];
  }
  systemPrompt() {
    return "If you need to retrieve the contents of a web page, use the fetch_web_page to make a GET request to a specified URL.";
  }

  provideTools = () => {
    return {
      type: "function",
      process: async (row) => {
        const resp = await fetch(row.url);
        return await resp.text();
      },
      function: {
        name: "fetch_web_page",
        description: "fetch a web page with HTTP(S) GET",
        parameters: {
          type: "object",
          required: ["url"],
          properties: {
            url: {
              description: "The URL to fetch with HTTP",
              type: "string",
            },
          },
        },
      },
    };
  };
}

module.exports = FetchSkill;

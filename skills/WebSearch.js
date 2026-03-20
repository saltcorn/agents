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

class WebSearchSkill {
  static skill_name = "Web search";

  get skill_label() {
    return "Web search";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    return [
      {
        name: "search_provider",
        label: "Search provider",
        type: "String",
        required: true,
        attributes: { options: ["By URL template"] },
      },
      {
        name: "url_template",
        label: "URL template",
        sublabel: "Use <code>{{q}}</code> for the URL-encoded search phrase",
        type: "String",
        required: true,
        showIf: { search_provider: "By URL template" },
      },
      {
        name: "header",
        label: "Header",
        sublabel: "For example <code>X-Subscription-Token: YOUR_API_KEY</code>",
        type: "String",
        showIf: { search_provider: "By URL template" },
      },
    ];
  }
  systemPrompt() {
    return "If you need to search the web with a search phrase, use the web_search to get search engine results";
  }

  provideTools = () => {
    return {
      type: "function",
      process: async (row) => {
        const fOpts = { method: "GET" };
        if (this.header) {
          const [key, val] = this.header.split(":");
          const myHeaders = new Headers();
          myHeaders.append(key, val.trim());
          fOpts.headers = myHeaders;
        }
        const url = interpolate(this.url_template, { q: row.search_phrase });
        const resp = await fetch(url);
        return await resp.text();
      },
      function: {
        name: "web_search",
        description: "Search the web with a search engine by a search phrase",
        parameters: {
          type: "object",
          required: ["search_phrase"],
          properties: {
            search_phrase: {
              description: "The phrase to search for",
              type: "string",
            },
          },
        },
      },
    };
  };
}

module.exports = WebSearchSkill;

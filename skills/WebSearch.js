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
        attributes: { options: ["By URL template", "Firecrawl", "Tavily"] },
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
        name: "api_key",
        label: "API key",
        type: "String",
        required: true,
        showIf: { search_provider: ["Firecrawl", "Tavily"] },
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
        switch (this.search_provider) {
          case "Firecrawl":
            {
              const url = "https://api.firecrawl.dev/v2/search";
              const options = {
                method: "POST",
                headers: {
                  Authorization: "Bearer " + this.api_key,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  query: row.search_phrase,
                  sources: ["web"],
                  categories: [],
                  limit: 10,
                  scrapeOptions: {
                    onlyMainContent: false,
                    maxAge: 172800000,
                    parsers: ["pdf"],
                    formats: [],
                  },
                }),
              };

              const response = await fetch(url, options);
              const data = await response.json();
              return data.data.web;
            }
            break;
          case "Tavily":
            {
              const url = "https://api.tavily.com/search";
              const options = {
                method: "POST",
                headers: {
                  Authorization: "Bearer " + this.api_key,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  query: row.search_phrase,
                  search_depth: "advanced",
                }),
              };

              const response = await fetch(url, options);
              const data = await response.json();
              return data.results;
            }
            break;
          case "By URL template":
          default:
            {
              const fOpts = { method: "GET" };
              if (this.header) {
                const [key, val] = this.header.split(":");
                const myHeaders = new Headers();
                myHeaders.append(key, val.trim());
                fOpts.headers = myHeaders;
              }
              const url = interpolate(this.url_template, {
                q: row.search_phrase,
              });
              const resp = await fetch(url);
              return await resp.text();
            }
            break;
        }
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

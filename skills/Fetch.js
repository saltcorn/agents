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

class CookieJar {
  constructor(source) {
    this.cookies = new Map();

    if (source instanceof CookieJar) {
      // Copy from another CookieJar instance
      for (const [name, value] of source.cookies) {
        this.cookies.set(name, value);
      }
    } else if (source && typeof source === "object") {
      // Hydrate from a plain object (e.g. output of toObject())
      for (const [name, value] of Object.entries(source)) {
        this.cookies.set(name, String(value));
      }
    }
    // If source is undefined/null, start empty
  }

  // Parse Set-Cookie headers from a response and store them
  storeFromResponse(response) {
    const setCookieHeaders = response.headers.getSetCookie
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);

    for (const header of setCookieHeaders) {
      this._parseAndStore(header);
    }
  }

  // Parse a single "name=value; Path=/; HttpOnly; ..." string
  _parseAndStore(header) {
    const [nameValue] = header.split(";");
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx > 0) {
      const name = nameValue.slice(0, eqIdx).trim();
      const value = nameValue.slice(eqIdx + 1).trim();
      this.cookies.set(name, value);
    }
  }

  // Build a Cookie header string suitable for outgoing requests
  toHeader() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  // Apply cookies to a headers object (mutates and returns it)
  applyTo(headers = {}) {
    if (this.cookies.size > 0) {
      headers["Cookie"] = this.toHeader();
    }
    return headers;
  }

  get size() {
    return this.cookies.size;
  }

  toObject() {
    return Object.fromEntries(this.cookies);
  }
}

class FetchSkill {
  static skill_name = "Fetch";

  get skill_label() {
    return "Fetch";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    return [{ name: "cookiejar", label: "Cookie Jar", type: "Bool" }];
  }
  systemPrompt() {
    return "If you need to retrieve the contents of a web page, use the fetch_web_page to make a GET request to a specified URL.";
  }

  provideTools = () => {
    return {
      type: "function",
      process: async (row, { run }) => {
        const opts = { headers: {} };
        const jar = new CookieJar(run.context.cookiejar || {});
        if (this.cookiejar) {
          opts.headers = jar.applyTo();
          opts.credentials = "same-origin";
          opts.redirect = "manual";
        }

        if (row.method) opts.method = row.method;
        if (row.content_type) opts.headers["Content-Type"] = row.content_type;
        if (row.body) opts.body = row.body;

        const resp = await fetch(row.url, opts);

        if (this.cookiejar) {
          jar.storeFromResponse(resp);
          run.context.cookiejar = jar.toObject();
        }
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
            method: {
              description: "The HTTP method",
              type: "string",
              enum: ["GET", "POST", "PUT", "DELETE"],
            },
            body: {
              description: "The request body as a string (POST and PUT only)",
              type: "string",
            },
            content_type: {
              description:
                "The request body content type, e.g. application/x-www-form-urlencoded or application/json (POST and PUT only)",
              type: "string",
            },
          },
        },
      },
    };
  };
}

module.exports = FetchSkill;

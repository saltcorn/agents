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

    it("generates text", async () => {
      const answer = await getState().functions.llm_generate.run(
        "What is the Capital of France?",
      );
      //console.log({ answer });

      expect(typeof answer).toBe("string");
      expect(answer).toContain("Paris");
    });
    it("generates text with system prompt", async () => {
      const answer = await getState().functions.llm_generate.run(
        "What is the name of the last week day in a normal work week?",
        {
          systemPrompt: "Answer in German, even when questions are in English",
        },
      );
      //console.log({ answer });

      expect(typeof answer).toBe("string");
      expect(answer).toContain("Freitag");
    });
    it("generates text with chat history", async () => {
      const chat = [
        {
          role: "user",
          content: "What is the capital of France?",
        },
        {
          role: "assistant",
          content: "Paris.",
        },
      ];
      const answer = await getState().functions.llm_generate.run(
        "What is the name of the river running through this city?",
        {
          chat,
        },
      );
      //console.log({ answer });

      expect(typeof answer).toBe("string");
      expect(answer).toContain("Seine");
      expect(chat.length).toBe(2);
    });
    it("generates text with chat history and no prompt", async () => {
      const answer = await getState().functions.llm_generate.run("", {
        chat: [
          {
            role: "user",
            content: "What is the capital of France?",
          },
          {
            role: "assistant",
            content: "Paris.",
          },
          {
            role: "user",
            content: "What is the name of the river running through this city?",
          },
        ],
      });
      //console.log({ answer });

      expect(typeof answer).toBe("string");
      expect(answer).toContain("Seine");
    });
    it("uses tools", async () => {
      const answer = await getState().functions.llm_generate.run(
        "Generate a list of EU capitals in a structured format using the provided tool",
        cities_tool,
      );
      expect(typeof answer).toBe("object");
      const cities = answer.ai_sdk
        ? answer.tool_calls[0].input?.cities
        : JSON.parse(answer.tool_calls[0].function.arguments).cities;
      expect(cities.length).toBe(27);
    });
    it("appends to chat history", async () => {
      const chat = [];
      const answer1 = await getState().functions.llm_generate.run(
        "What is the Capital of France?",
        {
          chat,
          appendToChat: true,
        },
      );
      const answer2 = await getState().functions.llm_generate.run(
        "What is the name of the river running through this city?",
        {
          chat,
          appendToChat: true,
        },
      );
      //console.log({ answer });

      expect(typeof answer2).toBe("string");
      expect(answer2).toContain("Seine");
      expect(chat.length).toBe(4);
    });
    it("tool use sequence", async () => {
      const chat = [];
      const answer = await getState().functions.llm_generate.run(
        "Generate a list of EU capitals in a structured format using the provided tool",
        { chat, appendToChat: true, ...cities_tool },
      );
      expect(typeof answer).toBe("object");
      const cities = answer.ai_sdk
        ? answer.tool_calls[0].input?.cities
        : JSON.parse(answer.tool_calls[0].function.arguments).cities;
      expect(cities.length).toBe(27);

      await getState().functions.llm_tool_response.run("List received", {
        chat,
      });

      const answer1 = await getState().functions.llm_generate.run(
        "Make the same list in a structured format using the provided tool but for the original 12 member countries of the EU",
        { chat, appendToChat: true, ...cities_tool },
      );
      const cities1 = answer1.ai_sdk
        ? answer1.tool_calls[0].input?.cities
        : JSON.parse(answer1.tool_calls[0].function.arguments).cities;
      expect(cities1.length).toBe(12);
    });
  });
}

const cities_tool = {
  tools: [
    {
      type: "function",
      function: {
        name: "cities",
        description: "Provide a list of cities by country and city name",
        parameters: {
          type: "object",
          properties: {
            cities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  country_name: {
                    type: "string",
                    description: "Country name",
                  },
                  city_name: {
                    type: "string",
                    description: "City name",
                  },
                },
                required: ["country_name", "city_name"],
              },
            },
          },
        },
      },
    },
  ],
  tool_choice: {
    type: "function",
    function: {
      name: "cities",
    },
  },
};

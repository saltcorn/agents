const { describe, it, expect } = require("@jest/globals");

const { parse } = require("node-html-parser");

const AskUserQuestion = require("../skills/AskUserQuestion");
const { normalizeOptions, fillTemplate } = AskUserQuestion;
const { user_actions_html } = require("../user_actions");

const req = { __: (s) => s };
const skill = (cfg) => new AskUserQuestion(cfg || {});
const tool = (cfg) => skill(cfg).provideTools();

const question = "Which database should I use?";
const options = [
  { label: "Postgres", description: "Best for production" },
  { label: "SQLite" },
];

describe("normalizeOptions", () => {
  it("accepts plain strings", () => {
    expect(normalizeOptions(["A", "B"])).toEqual([
      { label: "A" },
      { label: "B" },
    ]);
  });

  it("accepts a JSON string", () => {
    expect(normalizeOptions('[{"label":"A","description":"first"}]')).toEqual([
      { label: "A", description: "first" },
    ]);
  });

  it("accepts alternative spellings of label and description", () => {
    expect(normalizeOptions([{ name: "A", sublabel: "first" }])).toEqual([
      { label: "A", description: "first" },
    ]);
  });

  it("drops options without a usable label", () => {
    expect(
      normalizeOptions([{ description: "no label" }, "  ", null, "A"]),
    ).toEqual([{ label: "A" }]);
  });

  it("is empty for anything that is not a list", () => {
    expect(normalizeOptions(undefined)).toEqual([]);
    expect(normalizeOptions(42)).toEqual([]);
  });
});

describe("fillTemplate", () => {
  it("substitutes without HTML-escaping", () => {
    expect(fillTemplate('say "{{ answer }}"', { answer: "A & B" })).toBe(
      'say "A & B"',
    );
  });

  it("leaves unknown placeholders alone", () => {
    expect(fillTemplate("{{ nope }}", { answer: "A" })).toBe("{{ nope }}");
  });
});

describe("ask_user_question tool", () => {
  it("suspends the run and offers one button per option", async () => {
    const result = await tool().process({ question, options }, { req });
    expect(result.stop).toBe(true);
    expect(result.add_response).toContain(question);
    expect(result.add_user_action.length).toBe(2);
    expect(result.add_user_action.map((ua) => ua.label)).toEqual([
      "Postgres",
      "SQLite",
    ]);
    expect(result.add_user_action.map((ua) => ua.input)).toEqual([
      { answer_index: 0 },
      { answer_index: 1 },
    ]);
    expect(result.add_user_action.every((ua) => ua.single_use)).toBe(true);
    expect(
      result.add_user_action.every((ua) => ua.name === "answer_question"),
    ).toBe(true);
  });

  it("adds a discussion button only when asked for", async () => {
    const without = await tool().process({ question, options }, { req });
    expect(without.add_user_action.some((ua) => ua.input.discuss)).toBe(false);

    const with_disc = await tool().process(
      { question, options, allow_discussion: true },
      { req },
    );
    const disc = with_disc.add_user_action[2];
    expect(disc.input).toEqual({ discuss: true });
    expect(disc.label).toBe("Discuss instead");
  });

  it("uses the configured discussion button label", async () => {
    const result = await tool({ question_discuss_label: "Not sure" }).process(
      { question, options, allow_discussion: true },
      { req },
    );
    expect(result.add_user_action[2].label).toBe("Not sure");
  });

  it("tells the agent to try again if there are no options", async () => {
    const result = await tool().process({ question, options: [] }, { req });
    expect(result.error).toContain("ask_user_question");
    expect(result.stop).toBeUndefined();
    expect(result.add_user_action).toBeUndefined();
  });

  it("escapes button labels and descriptions coming from the model", async () => {
    const result = await tool().process(
      { question, options: [{ label: "<b>x</b>", description: 'a " quote' }] },
      { req },
    );
    const ua = result.add_user_action[0];
    expect(ua.label).not.toContain("<b>");
    expect(ua.click_replace_text).not.toContain("<b>");
    // an unescaped quote in the title attribute would end it
    expect(ua.title).not.toContain('"');
  });

  it("escapes radio labels and descriptions coming from the model", async () => {
    const result = await tool().process(
      {
        question,
        options: [
          { label: "<img src=x onerror=alert(1)>", description: 'a " quote' },
          { label: "something else entirely" },
        ],
      },
      { req },
    );
    const opt = result.add_user_action.options[0];
    expect(opt.label).not.toContain("<img");
    expect(opt.description).not.toContain('"');
    const html = user_actions_html(
      [{ ...result.add_user_action, rndid: "r0" }],
      "myview",
      { id: 7 },
    );
    expect(parse(html).querySelectorAll("img").length).toBe(0);
  });

  it("renders the question and the option descriptions", () => {
    const html = tool().renderToolCall({ question, options });
    expect(html).toContain(question);
    expect(html).toContain("Best for production");
    expect(html).not.toContain("<script");
  });
});

describe("switch to a radio group", () => {
  const kind = async (opts, rest) => {
    const result = await tool().process(
      { question, options: opts, ...(rest || {}) },
      { req },
    );
    const uas = Array.isArray(result.add_user_action)
      ? result.add_user_action
      : [result.add_user_action];
    return { type: uas[0].type, uas, result };
  };

  it("keeps buttons for short options", async () => {
    // 3 + 2 = 5 characters, nothing over 15
    expect((await kind(["Yes", "No"])).type).toBe("button");
    // 4 x 10 = 40 characters, exactly on the limit
    expect(
      (await kind(["0123456789", "123456789A", "23456789AB", "3456789ABC"]))
        .type,
    ).toBe("button");
  });

  it("switches when one option is longer than 15 characters", async () => {
    expect((await kind(["Yes", "0123456789012345"])).type).toBe("radio_group");
    expect((await kind(["Yes", "012345678901234"])).type).toBe("button");
  });

  it("switches when all the options together are longer than 40 characters", async () => {
    // 4 options of 10 and a 1: 41 characters, none of them long on its own
    expect(
      (
        await kind([
          "0123456789",
          "123456789A",
          "23456789AB",
          "3456789ABC",
          "x",
        ])
      ).type,
    ).toBe("radio_group");
  });

  it("puts every option, and the discussion choice, in one group", async () => {
    const { uas } = await kind(
      [
        { label: "Quarterly revenue by region", description: "Takes a minute" },
        { label: "Year-to-date summary" },
      ],
      { allow_discussion: true },
    );
    expect(uas.length).toBe(1);
    const ua = uas[0];
    expect(ua.name).toBe("answer_question");
    expect(ua.single_use).toBe(true);
    expect(ua.client_input_fields).toEqual(["choice"]);
    expect(ua.options.map((o) => o.value)).toEqual(["0", "1", "discuss"]);
    expect(ua.options[0].description).toBe("Takes a minute");
    expect(ua.options[2].label).toBe("Discuss instead");
  });

  it("has no discussion choice unless the agent asks for one", async () => {
    const { uas } = await kind([
      "Quarterly revenue by region",
      "Something else",
    ]);
    expect(uas[0].options.map((o) => o.value)).toEqual(["0", "1"]);
  });
});

describe("user action markup", () => {
  const render = async (row) => {
    const result = await tool().process({ question, ...row }, { req });
    const uas = (
      Array.isArray(result.add_user_action)
        ? result.add_user_action
        : [result.add_user_action]
    ).map((ua, ix) => ({ ...ua, rndid: `r${ix}` }));
    return parse(user_actions_html(uas, "myview", { id: 7 }));
  };

  it("survives HTML parsing with the handler intact", async () => {
    // the onclick sits in a double-quoted attribute: a double quote inside it
    // truncates the handler and the button does nothing when pressed
    const root = await render({ options: ["Yes", "No"] });
    const onclicks = root
      .querySelectorAll("button")
      .map((b) => b.getAttribute("onclick"));
    expect(onclicks.length).toBe(2);
    onclicks.forEach((onclick) => {
      expect(onclick).toContain("execute_user_action");
      expect(onclick).toContain("processExecuteResponse)");
      expect(onclick).toContain("run_id: 7");
    });
    expect(root.querySelectorAll("button[data-useraction-id]").length).toBe(2);
  });

  it("renders one radio per option, all in the same group", async () => {
    const root = await render({
      options: [
        { label: "Quarterly revenue by region", description: "Takes a minute" },
        { label: "Year-to-date summary" },
      ],
      allow_discussion: true,
    });
    const radios = root.querySelectorAll("input[type=radio]");
    expect(radios.map((r) => r.getAttribute("value"))).toEqual([
      "0",
      "1",
      "discuss",
    ]);
    expect(new Set(radios.map((r) => r.getAttribute("name"))).size).toBe(1);
    // every radio is labelled, and the labels point at the inputs
    expect(
      root.querySelectorAll("label").map((l) => l.getAttribute("for")),
    ).toEqual(radios.map((r) => r.getAttribute("id")));
    // the group as a whole is what gets taken away once it is answered
    expect(root.querySelectorAll("[data-useraction-id]").length).toBe(1);
  });

  it("sends the picked value, and does nothing until one is picked", async () => {
    const root = await render({
      options: ["Quarterly revenue by region", "Year-to-date summary"],
    });
    const onclick = root.querySelector("button").getAttribute("onclick");
    expect(onclick).toContain("input:checked");
    expect(onclick).toContain("ua_input: {choice:");
    expect(onclick).toContain("return false");
  });
});

describe("answering", () => {
  const answer = (cfg, input) =>
    skill(cfg).userActions.answer_question({ question, options, ...input });

  it("sends the chosen option back to the agent", async () => {
    const result = await answer({}, { answer_index: 0 });
    expect(result.generate_prompt).toBe(
      `In answer to the question "${question}", I choose: Postgres`,
    );
    expect(result.click_replace_text).toBe("Postgres");
  });

  it("accepts the value picked in a radio group", async () => {
    const result = await answer({}, { choice: "1" });
    expect(result.generate_prompt).toBe(
      `In answer to the question "${question}", I choose: SQLite`,
    );
    expect(result.click_replace_text).toBe("SQLite");
  });

  it("takes the discussion choice out of a radio group", async () => {
    const result = await answer({}, { choice: "discuss" });
    expect(result.generate_prompt).toContain("do not want to pick");
    expect(result.click_replace_text).toBe("Discuss instead");
  });

  it("does nothing if the radio group was submitted empty", async () => {
    expect(await answer({}, { choice: "" })).toEqual({});
  });

  it("sends the discussion prompt when the question is not answered", async () => {
    const result = await answer({}, { discuss: true });
    expect(result.generate_prompt).toContain(question);
    expect(result.generate_prompt).toContain("do not want to pick");
  });

  it("uses the configured answer prompt", async () => {
    const result = await answer(
      {
        question_answer_prompt:
          "Q: {{ question }} A: {{ answer }} ({{ answer_description }})",
      },
      { answer_index: 0 },
    );
    expect(result.generate_prompt).toBe(
      `Q: ${question} A: Postgres (Best for production)`,
    );
  });

  it("does nothing if the option no longer exists", async () => {
    expect(await answer({}, { answer_index: 7 })).toEqual({});
  });
});

describe("system prompt", () => {
  it("always explains the tool, and appends the configured prompt", () => {
    expect(skill().systemPrompt()).toContain("ask_user_question");
    const withCfg = skill({
      question_sys_prompt: "Always ask before deleting anything",
    }).systemPrompt();
    expect(withCfg).toContain("ask_user_question");
    expect(withCfg).toContain("Always ask before deleting anything");
  });
});

const { describe, it, expect } = require("@jest/globals");

const AskUserQuestion = require("../skills/AskUserQuestion");
const { normalizeOptions, fillTemplate } = AskUserQuestion;

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

  it("escapes labels and descriptions coming from the model", async () => {
    const result = await tool().process(
      {
        question,
        options: [
          { label: "<img src=x onerror=alert(1)>", description: 'a " quote' },
        ],
      },
      { req },
    );
    const ua = result.add_user_action[0];
    expect(ua.label).not.toContain("<img");
    expect(ua.click_replace_text).not.toContain("<img");
    expect(ua.title).not.toContain('"');
  });

  it("renders the question and the option descriptions", () => {
    const html = tool().renderToolCall({ question, options });
    expect(html).toContain(question);
    expect(html).toContain("Best for production");
    expect(html).not.toContain("<script");
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

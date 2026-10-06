const { describe, it, expect } = require("@saltcorn/db-common/test_expect");

const { parse } = require("node-html-parser");

const AskUserQuestion = require("../skills/AskUserQuestion");
const { normalizeOptions, normalizeQuestions, fillTemplate } = AskUserQuestion;
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
    const result = await tool().process(
      { questions: [{ question, header: "DB", type: "single_select" }] },
      { req },
    );
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
    expect(result.generate_prompt).toContain("do not want to answer");
    expect(result.click_replace_text).toBe("Discuss instead");
  });

  it("does nothing if the radio group was submitted empty", async () => {
    expect(await answer({}, { choice: "" })).toEqual({});
  });

  it("sends the discussion prompt when the question is not answered", async () => {
    const result = await answer({}, { discuss: true });
    expect(result.generate_prompt).toContain(question);
    expect(result.generate_prompt).toContain("do not want to answer");
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

describe("normalizeQuestions", () => {
  it("takes a single question at the top level as a single choice", () => {
    expect(normalizeQuestions({ question, options: ["A", "B"] })).toEqual([
      {
        question,
        type: "single_select",
        options: [{ label: "A" }, { label: "B" }],
        header: "Which database should I…",
      },
    ]);
  });

  it("reads a questions array, with other names for the types", () => {
    const qs = normalizeQuestions({
      questions: [
        { question: "Q1", header: "One", type: "checkbox", options: ["A"] },
        { question: "Q2", header: "Two", type: "text", options: ["ignored"] },
        { question: "Q3", type: "radio", options: ["A"] },
        { question: "Q4" },
      ],
    });
    expect(qs.map((q) => q.type)).toEqual([
      "multi_select",
      "free_text",
      "single_select",
      "free_text",
    ]);
    expect(qs[1].options).toEqual([]);
    expect(qs.map((q) => q.header)).toEqual(["One", "Two", "Q3", "Q4"]);
  });

  it("accepts the questions as a JSON string, and drops empty ones", () => {
    const qs = normalizeQuestions({
      questions: JSON.stringify([{ question: "  " }, { question: "Q" }]),
    });
    expect(qs.length).toBe(1);
    expect(qs[0].question).toBe("Q");
  });

  it("shortens long headers", () => {
    const [q] = normalizeQuestions({
      questions: [{ question: "Q", header: "x".repeat(60) }],
    });
    expect(q.header.length).toBeLessThan(30);
  });
});

const questions = [
  {
    question: "Which database should I use?",
    header: "Database",
    type: "single_select",
    options: [
      { label: "Postgres", description: "Best for production" },
      "SQLite",
    ],
  },
  {
    question: "Which features do you want?",
    header: "Features",
    type: "multi_select",
    options: ["Auth", "Search", "Billing"],
  },
  {
    question: "Anything else I should know?",
    header: "Notes",
    type: "free_text",
  },
];

describe("forms", () => {
  const process = (row, cfg) => tool(cfg).process(row, { req });

  it("asks several questions with one form", async () => {
    const result = await process({ questions });
    expect(result.stop).toBe(true);
    questions.forEach((q) => expect(result.add_response).toContain(q.question));
    expect(result.add_user_action.length).toBe(1);
    const [ua] = result.add_user_action;
    expect(ua.type).toBe("form");
    expect(ua.single_use).toBe(true);
    expect(ua.client_input_fields).toEqual(["answers"]);
    expect(ua.questions.map((q) => q.type)).toEqual([
      "single_select",
      "multi_select",
      "free_text",
    ]);
    expect(ua.questions.map((q) => q.header)).toEqual([
      "Database",
      "Features",
      "Notes",
    ]);
  });

  it("uses a form for a single question that is not single choice", async () => {
    const r1 = await process({ questions: [questions[1]] });
    expect(r1.add_user_action[0].type).toBe("form");
    const r2 = await process({ questions: [questions[2]] });
    expect(r2.add_user_action[0].type).toBe("form");
    // but a single single-choice question still gets buttons
    const r3 = await process({ questions: [questions[0]] });
    expect(r3.add_user_action[0].type).toBe("button");
  });

  it("adds a discussion button next to the form when asked for", async () => {
    const result = await process({ questions, allow_discussion: true });
    expect(result.add_user_action.length).toBe(2);
    expect(result.add_user_action[1].input).toEqual({ discuss: true });
  });

  it("tells the agent which question has no options", async () => {
    const result = await process({
      questions: [questions[2], { ...questions[1], options: [] }],
    });
    expect(result.error).toContain(questions[1].question);
    expect(result.add_user_action).toBeUndefined();
  });

  it("escapes everything coming from the model", async () => {
    const result = await process({
      questions: [
        {
          question: "<img src=x onerror=alert(1)>",
          header: "<b>h</b>",
          type: "multi_select",
          options: [{ label: "<script>x</script>", description: 'a " quote' }],
        },
        questions[2],
      ],
    });
    const [ua] = result.add_user_action;
    const html = user_actions_html([{ ...ua, rndid: "r0" }], "myview", {
      id: 7,
    });
    const root = parse(html);
    expect(root.querySelectorAll("img").length).toBe(0);
    expect(root.querySelectorAll("script").length).toBe(0);
    expect(root.querySelectorAll("b").length).toBe(0);
  });

  it("lists the questions by header in the tool call", () => {
    const html = tool().renderToolCall({ questions });
    expect(html).toContain("Database");
    expect(html).toContain(questions[2].question);
  });
});

describe("form markup", () => {
  const render = async (row) => {
    const result = await tool().process(row, { req });
    const uas = result.add_user_action.map((ua, ix) => ({
      ...ua,
      rndid: `r${ix}`,
    }));
    return parse(user_actions_html(uas, "myview", { id: 7 }));
  };

  it("puts several questions in tabs, the first one showing", async () => {
    const root = await render({ questions });
    const tabs = root.querySelectorAll(".ua-question-tab");
    expect(tabs.map((t) => t.text)).toEqual(["Database", "Features", "Notes"]);
    // the full question is on the tab as a tooltip
    expect(tabs[0].getAttribute("title")).toBe(questions[0].question);
    expect(tabs[0].classList.contains("active")).toBe(true);
    const panes = root.querySelectorAll(".ua-question-pane");
    expect(panes.map((p) => p.classList.contains("d-none"))).toEqual([
      false,
      true,
      true,
    ]);
    tabs.forEach((t) => expect(t.getAttribute("onclick")).toContain("d-none"));
  });

  it("renders radios, checkboxes and a text box", async () => {
    const root = await render({ questions });
    const panes = root.querySelectorAll(".ua-question-pane");
    expect(panes[0].querySelectorAll("input[type=radio]").length).toBe(2);
    expect(panes[1].querySelectorAll("input[type=checkbox]").length).toBe(3);
    expect(panes[2].querySelectorAll("textarea").length).toBe(1);
    // the inputs of one question share a name, different from the others
    const names = panes.map((p) =>
      p.querySelector("input, textarea").getAttribute("name"),
    );
    expect(new Set(names).size).toBe(3);
    // every choice is labelled, and the labels point at the inputs
    const inputs = root.querySelectorAll("input");
    expect(
      root.querySelectorAll("label").map((l) => l.getAttribute("for")),
    ).toEqual(inputs.map((i) => i.getAttribute("id")));
    // the whole form is what gets taken away once it is answered
    expect(root.querySelectorAll("[data-useraction-id]").length).toBe(1);
  });

  it("has no tabs for a single question", async () => {
    const root = await render({ questions: [questions[1]] });
    expect(root.querySelectorAll(".ua-question-tab").length).toBe(0);
    expect(root.querySelectorAll(".ua-question-pane.d-none").length).toBe(0);
  });

  it("sends all the answers with one button, with the handler intact", async () => {
    const root = await render({ questions });
    const submit = root.querySelectorAll("button").at(-1);
    const onclick = submit.getAttribute("onclick");
    expect(onclick).toContain("execute_user_action");
    expect(onclick).toContain("ua_input: {answers: a}");
    expect(onclick).toContain("processExecuteResponse)");
    expect(onclick).toContain("return false");
  });
});

describe("answering a form", () => {
  const answer = (answers, cfg, qs) =>
    skill(cfg).userActions.answer_question({
      questions: qs || questions,
      answers,
    });

  it("sends every answer back to the agent", async () => {
    const result = await answer(["0", ["2", "0"], "Ship by Friday"]);
    expect(result.generate_prompt).toBe(
      [
        `In answer to the question "Which database should I use?", I choose: Postgres`,
        `In answer to the question "Which features do you want?", I choose: Auth, Billing`,
        `In answer to the question "Anything else I should know?", I write: Ship by Friday`,
      ].join("\n\n"),
    );
    expect(result.click_replace_text).toContain(
      "<strong>Database</strong>: Postgres",
    );
    expect(result.click_replace_text).toContain("Auth, Billing");
  });

  it("accepts no options ticked and no text written", async () => {
    const result = await answer(["1", [], "  "]);
    expect(result.generate_prompt).toContain("I choose: none of the options");
    expect(result.generate_prompt).toContain("I write: (no answer)");
  });

  it("accepts the answers as a JSON string", async () => {
    const result = await answer(JSON.stringify(["1", ["1"], ""]));
    expect(result.generate_prompt).toContain("I choose: SQLite");
    expect(result.generate_prompt).toContain("I choose: Search");
  });

  it("ignores ticked options that do not exist", async () => {
    const result = await answer(["0", ["7", "1", "1"], ""]);
    expect(result.generate_prompt).toContain("I choose: Search\n");
  });

  it("does nothing if a single choice question is unanswered", async () => {
    expect(await answer([null, [], ""])).toEqual({});
    expect(await answer(["9", [], ""])).toEqual({});
  });

  it("does nothing if the answers do not match the questions", async () => {
    expect(await answer(["0"])).toEqual({});
    expect(await answer("not json")).toEqual({});
  });

  it("shows a single answer on its own, keeping line breaks", async () => {
    const result = await answer(["<b>a</b>\nb"], {}, [questions[2]]);
    expect(result.click_replace_text).toBe("&lt;b&gt;a&lt;/b&gt;<br>b");
  });

  it("names every question when the user wants to discuss", async () => {
    const result = await skill().userActions.answer_question({
      questions,
      discuss: true,
    });
    questions.forEach((q) =>
      expect(result.generate_prompt).toContain(q.question),
    );
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

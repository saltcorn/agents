const { div, ul, li, strong, text_attr } = require("@saltcorn/markup/tags");
const { get__ } = require("../utils");

// The message the agent sees as the tool result. The run is stopped at this
// point, so this is the last thing in the conversation until the user answers,
// which arrives as a new user message.
const describeQuestion = (q) =>
  q.type === "free_text"
    ? `"${q.question}" (to be answered in their own words)`
    : `"${q.question}" (${
        q.type === "multi_select" ? "choosing any number of" : "choosing one of"
      }: ${q.options.map((o) => `"${o.label}"`).join(", ")})`;

const AWAITING_RESPONSE = (questions) =>
  (questions.length === 1
    ? `The question ${describeQuestion(questions[0])} has been put to the user. `
    : `These questions have been put to the user: ${questions
        .map(describeQuestion)
        .join("; ")}. `) +
  `The conversation is paused until they answer. Their answer, or a request ` +
  `to discuss the question instead, will arrive as the next user message. ` +
  `Do not proceed, and do not guess what they will answer.`;

// A row of buttons only works while the labels are short. Past either of these
// the question is put as a radio group with a submit button instead.
const MAX_BUTTON_LABEL_CHARS = 15;
const MAX_BUTTON_TOTAL_CHARS = 40;

const useRadioGroup = (options) =>
  options.some((o) => o.label.length > MAX_BUTTON_LABEL_CHARS) ||
  options.reduce((tot, o) => tot + o.label.length, 0) > MAX_BUTTON_TOTAL_CHARS;

const DEFAULT_SYS_PROMPT = `When you need a decision that only the user can give, ask them with the ask_user_question tool rather than writing the question in your reply. A question can be single choice (the user picks one of the options you supply), multiple choice (the user ticks any number of them, possibly none) or free text (the user writes an answer). You can ask several related questions in one call; they are shown to the user in tabs. The conversation stops until the user answers, and their answers come back to you as a new user message. Do not use it for anything you can work out yourself. Never call it more than once at a time. If you only have a single free text question, perfer not asking it as a question but just reply to the user with your question - only use free text for very specific questions or in conjunction with other questions.`;

const DEFAULT_ANSWER_PROMPT = `In answer to the question "{{ question }}", I choose: {{ answer }}`;

const DEFAULT_TEXT_ANSWER_PROMPT = `In answer to the question "{{ question }}", I write: {{ answer }}`;

const DEFAULT_DISCUSS_PROMPT = `I do not want to answer yet. Let's discuss the question "{{ question }}" instead. Do not assume an answer, and do not carry on with the task until I have decided.`;

const DEFAULT_DISCUSS_LABEL = "Discuss instead";

// Fill {{ name }} or {{! name }} placeholders. Deliberately not the underscore
// template used elsewhere: the result is a chat message and not HTML, so the
// values must not be HTML-escaped.
const fillTemplate = (tpl, vars) =>
  tpl.replace(/\{\{\s*!?\s*([a-zA-Z_0-9]+)\s*\}\}/g, (m, k) =>
    typeof vars[k] === "undefined" || vars[k] === null ? m : String(vars[k]),
  );

// The options as given by the model, which does not always follow the schema:
// accept plain strings and a few other spellings of label and description.
const normalizeOptions = (options) => {
  let opts = options;
  if (typeof opts === "string") {
    try {
      opts = JSON.parse(opts);
    } catch {
      opts = opts.split("\n");
    }
  }
  if (!Array.isArray(opts)) return [];
  return opts
    .map((o) => {
      if (typeof o === "string") return { label: o };
      if (o && typeof o === "object")
        return {
          label: o.label ?? o.name ?? o.value ?? o.option ?? o.title,
          description: o.description ?? o.sublabel ?? o.detail,
        };
      return null;
    })
    .filter((o) => o && typeof o.label === "string" && o.label.trim())
    .map((o) => ({
      label: o.label.trim(),
      ...(typeof o.description === "string" && o.description.trim()
        ? { description: o.description.trim() }
        : {}),
    }));
};

const QUESTION_TYPES = ["single_select", "multi_select", "free_text"];

// The question type as given by the model, which may use another name for it.
// Without one, a question with options is single choice and one without is
// free text
const normalizeType = (type, hasOptions) => {
  const t = typeof type === "string" ? type.toLowerCase().trim() : "";
  if (QUESTION_TYPES.includes(t)) return t;
  if (/multi|checkbox|several|many/.test(t)) return "multi_select";
  if (/text|free|open|write|string/.test(t)) return "free_text";
  if (/single|radio|choice|select|one/.test(t)) return "single_select";
  return hasOptions ? "single_select" : "free_text";
};

const MAX_HEADER_CHARS = 20;

const truncate = (s, n) =>
  s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";

// A tab header: the one the model gave, or the start of the question if it
// gave none. Either is cut short so that the tabs fit next to each other
const makeHeader = (header, question, ix) =>
  truncate(header || question || `Question ${ix + 1}`, MAX_HEADER_CHARS + 5);

// The questions as given by the model: a questions array, or the single
// question and options at the top level of the call (the original form of the
// tool, which some models will still use)
const normalizeQuestions = (row) => {
  let qs = row?.questions;
  if (typeof qs === "string") {
    try {
      qs = JSON.parse(qs);
    } catch {
      qs = undefined;
    }
  }
  if (qs && !Array.isArray(qs) && typeof qs === "object") qs = [qs];
  if (!Array.isArray(qs) || !qs.length)
    qs = row?.question
      ? [{ question: row.question, options: row.options }]
      : [];
  return qs
    .filter((q) => q && typeof q === "object")
    .map((q) => {
      const question = String(q.question ?? q.text ?? q.prompt ?? "").trim();
      const options = normalizeOptions(q.options ?? q.choices);
      const type = normalizeType(q.type ?? q.kind, options.length > 0);
      return {
        question,
        type,
        options: type === "free_text" ? [] : options,
        header:
          typeof (q.header ?? q.title) === "string" &&
          (q.header ?? q.title).trim()
            ? (q.header ?? q.title).trim()
            : "",
      };
    })
    .filter((q) => q.question)
    .map((q, ix) => ({ ...q, header: makeHeader(q.header, q.question, ix) }));
};

// The answers sent from the browser for a form, as an array with one entry
// per question
const parseAnswers = (answers) => {
  if (typeof answers === "string") {
    try {
      return JSON.parse(answers);
    } catch {
      return null;
    }
  }
  return answers;
};

// Text for the chat: escaped, with the line breaks of a free text answer kept
const textToHtml = (s) => text_attr(s).replace(/\r?\n/g, "<br>");

class AskUserQuestionSkill {
  static skill_name = "Ask user question";

  get skill_label() {
    return "Question";
  }

  constructor(cfg) {
    Object.assign(this, cfg || {});
  }

  static async configFields() {
    return [
      {
        name: "question_sys_prompt",
        label: "Additional system prompt",
        type: "String",
        fieldview: "textarea",
        sublabel:
          "Optional. When should the agent ask a question? Added to the standard instructions. Refer to the tool as <code>ask_user_question</code>",
      },
      {
        name: "question_answer_prompt",
        label: "Prompt on answer",
        type: "String",
        fieldview: "textarea",
        sublabel:
          "Optional. The message sent to the agent for each question the user answers. Use <code>{{ question }}</code>, <code>{{ answer }}</code> and <code>{{ answer_description }}</code>. Default: <code>" +
          DEFAULT_ANSWER_PROMPT +
          "</code>, or for a free text question <code>" +
          DEFAULT_TEXT_ANSWER_PROMPT +
          "</code>",
      },
      {
        name: "question_discuss_label",
        label: "Discuss button label",
        type: "String",
        sublabel:
          "Optional. Shown on the extra button when the agent offers to discuss the question rather than have it answered. Default: <code>" +
          DEFAULT_DISCUSS_LABEL +
          "</code>",
      },
      {
        name: "question_discuss_prompt",
        label: "Prompt on discuss",
        type: "String",
        fieldview: "textarea",
        sublabel:
          "Optional. The message sent to the agent when the user presses the discuss button. Use <code>{{ question }}</code>. Default: <code>" +
          DEFAULT_DISCUSS_PROMPT +
          "</code>",
      },
    ];
  }

  systemPrompt() {
    return [DEFAULT_SYS_PROMPT, this.question_sys_prompt]
      .filter((s) => s && s.trim())
      .join("\n\n");
  }

  get discussLabel() {
    return this.question_discuss_label?.trim() || DEFAULT_DISCUSS_LABEL;
  }

  // The message sent to the agent for one answered question
  answerPrompt(q, answer, answer_description) {
    const custom = this.question_answer_prompt?.trim();
    return fillTemplate(
      custom ||
        (q.type === "free_text"
          ? DEFAULT_TEXT_ANSWER_PROMPT
          : DEFAULT_ANSWER_PROMPT),
      {
        question: q.question || "",
        answer,
        answer_description: answer_description || "",
      },
    );
  }

  discussResult(questions) {
    return {
      generate_prompt: fillTemplate(
        this.question_discuss_prompt?.trim() || DEFAULT_DISCUSS_PROMPT,
        { question: questions.map((q) => q.question).join(" / ") },
      ),
      click_replace_text: text_attr(this.discussLabel),
    };
  }

  // The answers to a form, one per question. Nothing is sent (so the form can
  // be answered again) if a single choice question is unanswered or the
  // answers do not match the questions
  formResult(questions, answers) {
    if (!Array.isArray(answers) || answers.length !== questions.length)
      return {};
    const answered = [];
    for (const [ix, q] of questions.entries()) {
      const a = answers[ix];
      if (q.type === "free_text") {
        const text = typeof a === "string" ? a.trim() : "";
        answered.push({
          q,
          answer: text || "(no answer)",
        });
      } else if (q.type === "multi_select") {
        const picked = (Array.isArray(a) ? a : [])
          .map((v) => parseInt(v, 10))
          .filter((v, i, arr) => q.options[v] && arr.indexOf(v) === i)
          .sort((x, y) => x - y)
          .map((v) => q.options[v]);
        answered.push({
          q,
          answer: picked.length
            ? picked.map((o) => o.label).join(", ")
            : "none of the options",
          answer_description: picked
            .filter((o) => o.description)
            .map((o) => `${o.label}: ${o.description}`)
            .join("; "),
        });
      } else {
        const opt = q.options[parseInt(a, 10)];
        if (!opt) return {};
        answered.push({
          q,
          answer: opt.label,
          answer_description: opt.description,
        });
      }
    }
    return {
      generate_prompt: answered
        .map(({ q, answer, answer_description }) =>
          this.answerPrompt(q, answer, answer_description),
        )
        .join("\n\n"),
      click_replace_text:
        answered.length === 1
          ? textToHtml(answered[0].answer)
          : answered
              .map(
                ({ q, answer }) =>
                  `<strong>${text_attr(q.header)}</strong>: ${textToHtml(
                    answer,
                  )}`,
              )
              .join("<br>"),
    };
  }

  get userActions() {
    return {
      answer_question: async (row) => {
        const { answer_index, discuss, choice, answers } = row;
        const questions = normalizeQuestions(row);
        if (!questions.length) return {};
        // a form reports the answers to all its questions together
        if (typeof answers !== "undefined" && answers !== null)
          return this.formResult(questions, parseAnswers(answers));
        // a button carries its answer in answer_index or discuss, a radio group
        // reports the value picked in the browser as choice
        let index = answer_index;
        let is_discuss = !!discuss;
        if (typeof choice !== "undefined" && choice !== null && choice !== "") {
          if (choice === "discuss") is_discuss = true;
          else index = parseInt(choice, 10);
        }
        if (is_discuss) return this.discussResult(questions);
        const q = questions[0];
        const opt = q.options[index];
        if (!opt) return {};
        return {
          generate_prompt: this.answerPrompt(q, opt.label, opt.description),
          click_replace_text: text_attr(opt.label),
        };
      },
    };
  }

  provideTools = () => {
    return {
      type: "function",
      process: async (row, { req }) => {
        const __ = get__(req);

        const questions = normalizeQuestions(row);
        if (!questions.length)
          return {
            error:
              "No question given. Call ask_user_question again with a questions array, each question with a question text and a type.",
          };
        const without_options = questions.filter(
          (q) => q.type !== "free_text" && q.options.length < 1,
        );
        if (without_options.length)
          return {
            error: `No options given for the question "${without_options[0].question}". Call ask_user_question again with at least two options, each with a label, for every single_select or multi_select question, or make it a free_text question.`,
          };
        const discuss_label = this.question_discuss_label?.trim()
          ? this.discussLabel
          : __(DEFAULT_DISCUSS_LABEL);
        const answer = {
          stop: true,
          add_response: AWAITING_RESPONSE(questions),
        };
        const discuss_button = {
          name: "answer_question",
          type: "button",
          label: text_attr(discuss_label),
          class: "btn btn-outline-secondary",
          click_replace_text: text_attr(discuss_label),
          single_use: true,
          input: { discuss: true },
        };
        const [first] = questions;
        if (questions.length > 1 || first.type !== "single_select") {
          // several questions, or one that is not a single choice: a form,
          // in tabs if there is more than one question, sent with one submit
          // button. The answers come back from the browser
          answer.add_user_action = [
            {
              name: "answer_question",
              type: "form",
              questions: questions.map((q) => ({
                type: q.type,
                question: text_attr(q.question),
                header: text_attr(q.header),
                options: q.options.map((opt) => ({
                  label: text_attr(opt.label),
                  ...(opt.description
                    ? { description: text_attr(opt.description) }
                    : {}),
                })),
              })),
              submit_label: __("Answer"),
              single_use: true,
              client_input_fields: ["answers"],
              input: {},
            },
            ...(row.allow_discussion ? [discuss_button] : []),
          ];
          return answer;
        }
        const options = first.options;
        if (useRadioGroup(options)) {
          // long options do not fit on buttons: one radio group answered with a
          // submit button, the picked value comes back from the browser
          answer.add_user_action = {
            name: "answer_question",
            type: "radio_group",
            options: [
              ...options.map((opt, ix) => ({
                value: `${ix}`,
                label: text_attr(opt.label),
                ...(opt.description
                  ? { description: text_attr(opt.description) }
                  : {}),
              })),
              ...(row.allow_discussion
                ? [{ value: "discuss", label: text_attr(discuss_label) }]
                : []),
            ],
            submit_label: __("Answer"),
            single_use: true,
            client_input_fields: ["choice"],
            input: {},
          };
          return answer;
        }
        // one button per option. The user action is shared, the option is
        // identified by the index carried in the button's input
        const user_actions = options.map((opt, ix) => ({
          name: "answer_question",
          type: "button",
          label: text_attr(opt.label),
          ...(opt.description ? { title: text_attr(opt.description) } : {}),
          click_replace_text: text_attr(opt.label),
          single_use: true,
          input: { answer_index: ix },
        }));
        if (row.allow_discussion) user_actions.push(discuss_button);
        answer.add_user_action = user_actions;
        return answer;
      },
      renderToolCall(row) {
        const questions = normalizeQuestions(row);
        // several questions are listed by their headers, their full text and
        // options are in the tabs below
        if (questions.length > 1)
          return ul(
            questions.map((q) =>
              li(strong(text_attr(q.header)), ": ", text_attr(q.question)),
            ),
          );
        const [q] = questions;
        if (!q) return "";
        const withDescr = q.options.filter((o) => o.description);
        return div(
          strong(text_attr(q.question)),
          withDescr.length && q.type === "single_select"
            ? ul(
                withDescr.map((o) =>
                  li(
                    strong(text_attr(o.label)),
                    ": ",
                    text_attr(o.description),
                  ),
                ),
              )
            : "",
        );
      },
      function: {
        name: "ask_user_question",
        description:
          "Ask the user one or more questions and wait for the answers. Each question is single choice (pick one option), multiple choice (tick any number of options, or none) or free text (a written answer). When there is more than one question they are shown in tabs, and the user answers them all before submitting. The conversation is suspended: nothing further happens until the user answers, and their answers are reported back as a new user message. Use this when you need a decision or information that only the user can give.",
        parameters: {
          type: "object",
          required: ["questions"],
          properties: {
            questions: {
              description:
                "The questions to put to the user, usually one. Ask several at once (up to six) only when they are related and you need all the answers before you can continue",
              type: "array",
              items: {
                type: "object",
                required: ["question", "header", "type"],
                properties: {
                  question: {
                    description:
                      "The question to put to the user, as a single sentence",
                    type: "string",
                  },
                  header: {
                    description: `A very short name for the question, shown on its tab when there are several questions. One to three words, at most ${MAX_HEADER_CHARS} characters, and distinct from the headers of the other questions. Examples: "Database", "Deploy target", "Notes"`,
                    type: "string",
                  },
                  type: {
                    description:
                      "single_select: the user picks exactly one of the options. multi_select: the user ticks any number of the options, possibly none. free_text: the user writes an answer in a text box, no options",
                    type: "string",
                    enum: QUESTION_TYPES,
                  },
                  options: {
                    description:
                      "For single_select and multi_select questions, the alternatives the user can choose between: between two and six options. For single_select they must be mutually exclusive. Leave out for free_text",
                    type: "array",
                    items: {
                      type: "object",
                      required: ["label"],
                      properties: {
                        label: {
                          description:
                            "The text of the option. A few words at most, and distinct from the other labels",
                          type: "string",
                        },
                        description: {
                          description:
                            "Optional. What this option means, or what happens if it is chosen",
                          type: "string",
                        },
                      },
                    },
                  },
                },
              },
            },
            allow_discussion: {
              description:
                "If true, the user is offered an additional button to not answer and discuss the question with you instead. Set this when the options may not be exhaustive, or when the user may need to know more before they can answer",
              type: "boolean",
            },
          },
        },
      },
    };
  };
}

module.exports = AskUserQuestionSkill;
module.exports.normalizeOptions = normalizeOptions;
module.exports.normalizeQuestions = normalizeQuestions;
module.exports.fillTemplate = fillTemplate;

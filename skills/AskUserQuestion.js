const { div, ul, li, strong, text_attr } = require("@saltcorn/markup/tags");

// The message the agent sees as the tool result. The run is stopped at this
// point, so this is the last thing in the conversation until the user picks an
// option, which arrives as a new user message.
const AWAITING_RESPONSE = (question, labels) =>
  `The question "${question}" has been put to the user, who can answer by ` +
  `pressing one of these buttons: ${labels.map((l) => `"${l}"`).join(", ")}. ` +
  `The conversation is paused until they answer. Their answer, or a request ` +
  `to discuss the question instead, will arrive as the next user message. ` +
  `Do not proceed, and do not guess what they will pick.`;

const DEFAULT_SYS_PROMPT = `When you need a decision that only the user can make, and there is a small number of concrete alternatives, ask them with the ask_user_question tool rather than writing the question in your reply. The conversation stops until the user picks one of the options you supply, and their choice comes back to you as a new user message. Use it for choices, not for open-ended questions or for anything you can work out yourself. Never call it more than once at a time.`;

const DEFAULT_ANSWER_PROMPT = `In answer to the question "{{ question }}", I choose: {{ answer }}`;

const DEFAULT_DISCUSS_PROMPT = `I do not want to pick any of those options yet. Let's discuss the question "{{ question }}" instead. Do not assume an answer, and do not carry on with the task until I have decided.`;

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
          "Optional. The message sent to the agent when the user picks an option. Use <code>{{ question }}</code>, <code>{{ answer }}</code> and <code>{{ answer_description }}</code>. Default: <code>" +
          DEFAULT_ANSWER_PROMPT +
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

  get userActions() {
    return {
      answer_question: async ({ question, options, answer_index, discuss }) => {
        if (discuss)
          return {
            generate_prompt: fillTemplate(
              this.question_discuss_prompt?.trim() || DEFAULT_DISCUSS_PROMPT,
              { question: question || "" },
            ),
          };
        const opt = normalizeOptions(options)[answer_index];
        if (!opt) return {};
        return {
          generate_prompt: fillTemplate(
            this.question_answer_prompt?.trim() || DEFAULT_ANSWER_PROMPT,
            {
              question: question || "",
              answer: opt.label,
              answer_description: opt.description || "",
            },
          ),
        };
      },
    };
  }

  provideTools = () => {
    return {
      type: "function",
      process: async (row, { req }) => {
        const __ = req?.__ ? (s) => req.__(s) : (s) => s;
        const options = normalizeOptions(row.options);
        if (options.length < 1)
          return {
            error:
              "No options given. Call ask_user_question again with at least two options, each with a label.",
          };
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
        if (row.allow_discussion)
          user_actions.push({
            name: "answer_question",
            type: "button",
            label: text_attr(
              this.question_discuss_label?.trim() || __(DEFAULT_DISCUSS_LABEL),
            ),
            class: "btn btn-outline-secondary",
            click_replace_text: text_attr(
              this.question_discuss_label?.trim() || __(DEFAULT_DISCUSS_LABEL),
            ),
            single_use: true,
            input: { discuss: true },
          });
        return {
          stop: true,
          add_response: AWAITING_RESPONSE(
            row.question || "",
            options.map((o) => o.label),
          ),
          add_user_action: user_actions,
        };
      },
      renderToolCall({ question, options }) {
        const opts = normalizeOptions(options);
        const withDescr = opts.filter((o) => o.description);
        return div(
          strong(text_attr(question || "")),
          withDescr.length
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
          "Ask the user a multiple-choice question and wait for the answer. The conversation is suspended: nothing further happens until the user presses one of the option buttons, and their choice is reported back as a new user message. Use this when you need a decision that only the user can make and there is a small number of concrete alternatives. Do not use it for open-ended questions, write those in your reply instead.",
        parameters: {
          type: "object",
          required: ["question", "options"],
          properties: {
            question: {
              description:
                "The question to put to the user, as a single sentence",
              type: "string",
            },
            options: {
              description:
                "The alternatives the user can choose between. Give between two and six mutually exclusive options",
              type: "array",
              items: {
                type: "object",
                required: ["label"],
                properties: {
                  label: {
                    description:
                      "The text on the button. A few words at most, and distinct from the other labels",
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
            allow_discussion: {
              description:
                "If true, the user is offered an additional button to not answer and discuss the question with you instead. Set this when the options may not be exhaustive, or when the user may need to know more before they can choose",
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
module.exports.fillTemplate = fillTemplate;

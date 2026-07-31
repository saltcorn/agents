const { getState } = require("@saltcorn/data/db/state");
const { div, i } = require("@saltcorn/markup/tags");
const { addToContext } = require("../common");
const { compactChat, DEFAULTS } = require("./compaction_lib");

// A message the user can type to compact the conversation by hand, the way
// they would in a coding agent. Anything after it steers the summary.
const MANUAL_COMMAND = /^\s*\/compact\b\s*/i;

const manualCommand = (chat) => {
  const last = chat[chat.length - 1];
  if (last?.role !== "user" || typeof last.content !== "string") return;
  if (!MANUAL_COMMAND.test(last.content)) return;
  return {
    // the message itself, not its position: compaction removes messages from
    // the middle of the chat, so any index taken now is stale afterwards
    message: last,
    focus: last.content.replace(MANUAL_COMMAND, "").trim(),
  };
};

class CompactionSkill {
  static skill_name = "Compaction";

  get skill_label() {
    return "Compaction";
  }

  constructor(cfg) {
    Object.assign(this, cfg);
  }

  static async configFields() {
    const llm_cfg_fun = getState().functions.llm_get_configuration;
    const alt_config_options = llm_cfg_fun
      ? llm_cfg_fun.run().alt_config_names || []
      : [];
    return [
      {
        name: "trigger_tokens",
        label: "Compact above",
        sublabel:
          "Tokens. When the conversation is estimated to be larger than this, it is shortened before the next question is sent to the model. Set this below the context window of the model you use.",
        type: "Integer",
        default: DEFAULTS.trigger_tokens,
      },
      {
        name: "strategy",
        label: "How to shorten",
        sublabel:
          "Clearing old tool results is free and usually enough. Summarizing costs an extra call to the model.",
        type: "String",
        required: true,
        attributes: {
          options: [
            "Both",
            "Clear old tool results",
            "Summarize older messages",
          ],
        },
        default: DEFAULTS.strategy,
      },
      {
        name: "protect_tool_output_tokens",
        label: "Keep recent tool results",
        sublabel:
          "Tokens of the most recent tool output that is never cleared. The results of the tool calls the agent is working on right now are always kept.",
        type: "Integer",
        default: DEFAULTS.protect_tool_output_tokens,
        showIf: { strategy: ["Both", "Clear old tool results"] },
      },
      {
        name: "min_clear_tokens",
        label: "Minimum worth clearing",
        sublabel:
          "Tokens. Old tool results are only cleared if doing so frees at least this much, so that little is lost for little gain.",
        type: "Integer",
        default: DEFAULTS.min_clear_tokens,
        showIf: { strategy: ["Both", "Clear old tool results"] },
      },
      {
        name: "keep_recent_tokens",
        label: "Keep recent messages",
        sublabel:
          "Tokens of the most recent conversation that is kept word for word and never replaced by the summary.",
        type: "Integer",
        default: DEFAULTS.keep_recent_tokens,
        showIf: { strategy: ["Both", "Summarize older messages"] },
      },
      {
        name: "summary_instructions",
        label: "Summary instructions",
        sublabel:
          "Optional. What the summary should pay particular attention to for this agent, for example which identifiers must never be lost.",
        type: "String",
        fieldview: "textarea",
        showIf: { strategy: ["Both", "Summarize older messages"] },
      },
      ...(alt_config_options.length
        ? [
            {
              name: "summary_alt_config",
              label: "Summarize with",
              sublabel:
                "Optional. Write the summary with a different, usually cheaper, LLM configuration.",
              type: "String",
              attributes: { options: alt_config_options },
              showIf: { strategy: ["Both", "Summarize older messages"] },
            },
          ]
        : []),
      {
        name: "summary_model",
        label: "Summary model",
        sublabel: "Optional. Override the model name for the summary only.",
        type: "String",
        showIf: { strategy: ["Both", "Summarize older messages"] },
      },
      {
        name: "tool_result_max_chars",
        label: "Tool result size in summary",
        sublabel:
          "Characters. Tool results longer than this are truncated when the conversation is handed to the summarizer.",
        type: "Integer",
        default: DEFAULTS.tool_result_max_chars,
        showIf: { strategy: ["Both", "Summarize older messages"] },
      },
      {
        name: "summary_input_max_chars",
        label: "Total size in summary",
        sublabel:
          "Characters. The whole conversation handed to the summarizer is kept below this, because that request has to fit in the context window too.",
        type: "Integer",
        default: DEFAULTS.summary_input_max_chars,
        showIf: { strategy: ["Both", "Summarize older messages"] },
      },
      {
        name: "manual_command",
        label: "Allow /compact",
        sublabel:
          "The user can type <code>/compact</code> to shorten the conversation immediately. Any text after the command steers the summary.",
        type: "Bool",
        default: true,
      },
      {
        name: "show_notice",
        label: "Show a notice",
        sublabel:
          "Tell the user in the chat when the conversation has been shortened.",
        type: "Bool",
        default: true,
      },
      {
        name: "keep_archive",
        label: "Keep a record",
        sublabel:
          "Store what was summarized away in the run, for debugging. The chat display always keeps the full conversation whether this is set or not.",
        type: "Bool",
        default: true,
      },
    ];
  }

  systemPrompt() {
    return `If this conversation becomes too long for your context window, the earlier messages are replaced by a summary of them, marked with <conversation-summary>. Treat everything in that summary as your own memory of what happened earlier. If you need a detail that is not in it, look it up again with your tools rather than asking the user for something they have already told you.`;
  }

  // The summarization call: no tools, its own system prompt, and optionally a
  // cheaper configuration than the agent itself runs on.
  summaryGenerator(config) {
    return async (prompt, opts = {}) => {
      const alt_config = this.summary_alt_config || config?.alt_config;
      // a different configuration is likely to have different model names, so
      // the agent's model is only carried over when the configuration is
      const model =
        this.summary_model ||
        (this.summary_alt_config ? undefined : config?.model);
      return await getState().functions.llm_generate.run(prompt, {
        ...opts,
        ...(alt_config ? { alt_config } : {}),
        ...(model ? { model } : {}),
      });
    };
  }

  /**
   * Called just before the chat is sent to the LLM. The chat array is the one
   * that is about to be sent, so it is shortened in place.
   */
  async beforeGenerate({ run, chat, config, req, usage, forced }) {
    if (!Array.isArray(chat) || chat.length < 3) return {};

    const manual =
      forced || this.manual_command === false ? undefined : manualCommand(chat);
    const cfg = manual?.focus
      ? { ...this, summary_instructions: manual.focus }
      : this;

    const report = await compactChat({
      chat,
      cfg,
      state: run.context?.compaction,
      usage,
      force: !!forced || !!manual,
      generate: this.summaryGenerator(config),
      log: (msg) => getState().log(4, `[run ${run.id}] ${msg}`),
    });

    if (manual) {
      // the command itself is not a question for the model. The newest message
      // is always retained by the cut, so it is still in the chat - but not
      // necessarily at the position it was at before compaction
      const at = chat.indexOf(manual.message);
      if (at >= 0)
        chat[at] = {
          role: "user",
          content: report.compacted
            ? "The conversation above has been shortened. Carry on from where we were."
            : "There was not enough to shorten. Carry on from where we were.",
        };
    }
    if (!report.compacted) {
      if (report.reason && report.reason !== "under threshold")
        getState().log(4, `[run ${run.id}] not compacted: ${report.reason}`);
      if (manual) await addToContext(run, { interactions: chat });
      return report;
    }

    const state = run.context?.compaction || {};
    await addToContext(run, {
      interactions: chat,
      compaction: {
        count: (state.count || 0) + 1,
        at: new Date().toISOString(),
        at_message_count: chat.length,
        tokens_before: report.tokens_before,
        tokens_after: report.tokens_after,
        cleared: report.cleared,
        messages_removed: report.messages_removed,
        ...(report.summarized ? { summary: report.summary } : {}),
        ...(this.keep_archive === false
          ? {}
          : { archive: this.archiveOf(report) }),
      },
    });
    if (this.show_notice !== false)
      await addToContext(run, {
        html_interactions: [this.notice(report)],
      });
    return report;
  }

  /**
   * Called by process_interaction when the provider rejected the request as
   * too large despite the estimate. Compacts as hard as the configuration
   * allows; the caller retries the turn once if this reports success.
   */
  async recoverContextOverflow({ run, chat, config, req, usage }) {
    getState().log(
      2,
      `[run ${run.id}] context overflow reported by the provider, compacting and retrying once`,
    );
    const report = await this.beforeGenerate({
      run,
      chat,
      config,
      req,
      usage,
      forced: true,
    });
    await addToContext(run, {
      compaction: { overflow_recovered_at: chat.length },
    });
    return report;
  }

  // What compaction threw away, bounded: the text that was handed to the
  // summarizer is already capped, and is far smaller than a copy of the whole
  // conversation would be. Cleared tool output is not kept - it is still in
  // the chat display, which compaction never touches.
  archiveOf(report) {
    return {
      at: new Date().toISOString(),
      tokens_before: report.tokens_before,
      tokens_after: report.tokens_after,
      cleared_tool_results: report.cleared,
      messages_removed: report.messages_removed,
      ...(report.serialized ? { summarized: report.serialized } : {}),
    };
  }

  notice(report) {
    const saved = Math.max(
      0,
      (report.tokens_before || 0) - (report.tokens_after || 0),
    );
    const what = report.summarized
      ? `${report.messages_removed} earlier messages were replaced by a summary`
      : `${report.cleared} old tool results were cleared`;
    return div(
      { class: "text-muted small text-center my-2 compaction-notice" },
      i({ class: "fas fa-compress-alt me-1" }),
      `Context shortened: ${what}, freeing about ${saved.toLocaleString()} tokens.`,
    );
  }
}

module.exports = CompactionSkill;

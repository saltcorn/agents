/**
 * Pure helpers for shrinking an agent chat that has grown too large for the
 * model's context window.
 *
 * Nothing in here touches the database, the Saltcorn state or the LLM: the
 * summarization call is passed in as a `generate` function. That keeps the
 * whole file unit-testable and makes it safe to require from anywhere.
 *
 * Three chat wire shapes are in use, depending on the LLM backend, and every
 * function that inspects a message has to handle all of them:
 *
 *   AI SDK           assistant: {role, content: [{type: "tool-call", toolCallId, toolName, input}]}
 *                    result:    {role: "tool", content: [{type: "tool-result", toolCallId, output: {type, value}}]}
 *   OpenAI chat      assistant: {role, tool_calls: [{id, function: {name, arguments}}]}
 *                    result:    {role: "tool", tool_call_id, content}
 *   OpenAI responses call:      {type: "function_call", call_id, name, arguments}
 *                    result:    {type: "function_call_output", call_id, output}
 */

const CHARS_PER_TOKEN = 4;

// An image is billed at roughly a fixed rate whatever the size of its payload,
// so its base64 must not be counted by length.
const IMAGE_CHARS = 4800;

// Placeholder left behind when the content of an old tool result is dropped.
const CLEARED_TEXT = "[Old tool result content cleared]";

// The summary lives in an ordinary user message, identified by this marker in
// its text. Messages must not carry extra keys of ours - they are sent to the
// provider as they are, and may be rejected.
const SUMMARY_OPEN = "<conversation-summary>";
const SUMMARY_CLOSE = "</conversation-summary>";

const ACK_TEXT =
  "I have read the summary of the earlier conversation and will continue from there.";

// Compacting immediately after a compaction achieves nothing: the reported
// usage still describes the pre-compaction chat.
const MIN_NEW_MESSAGES = 2;

// Summarizing a handful of messages costs an LLM call and saves nothing.
const MIN_HEAD_MESSAGES = 4;
const MIN_HEAD_TOKENS = 1000;

// How far past the first valid cut point we look for a turn boundary. Cutting
// at a user message keeps the retained tail a set of whole turns, at the cost
// of dropping a few more messages than the budget strictly requires.
const USER_SNAP_WINDOW = 6;

const DEFAULTS = {
  trigger_tokens: 100000,
  keep_recent_tokens: 8000,
  protect_tool_output_tokens: 20000,
  min_clear_tokens: 20000,
  tool_result_max_chars: 2000,
  // the summarization call has to fit in the window that is already full:
  // ~30k tokens of input leaves room for any model
  summary_input_max_chars: 120000,
  strategy: "Both",
};

// The floor the per-tool-result cap is tightened to when the serialized
// conversation does not fit.
const MIN_TOOL_RESULT_CHARS = 200;

const numOr = (v, dflt) => {
  const n = typeof v === "string" ? parseInt(v, 10) : v;
  return typeof n === "number" && !isNaN(n) ? n : dflt;
};

const clearsToolResults = (cfg) =>
  (cfg?.strategy || DEFAULTS.strategy) !== "Summarize older messages";

const summarizes = (cfg) =>
  (cfg?.strategy || DEFAULTS.strategy) !== "Clear old tool results";

//
// -------------------------------------------------------------- token counts
//

const isMediaPart = (part) =>
  !!part &&
  typeof part === "object" &&
  ["image", "file", "image_url", "input_image", "input_file"].includes(
    part.type,
  );

// Character count of anything in a chat, with media payloads counted flat
// rather than by the length of their base64.
const countChars = (x) => {
  if (x === null || typeof x === "undefined") return 0;
  if (typeof x === "string") return x.length;
  if (typeof x !== "object") return String(x).length;
  if (Array.isArray(x)) return x.reduce((sum, y) => sum + countChars(y), 0);
  if (isMediaPart(x)) return IMAGE_CHARS;
  let chars = 2; // braces
  for (const [k, v] of Object.entries(x)) chars += k.length + 4 + countChars(v);
  return chars;
};

const estimateTokens = (msg) => Math.ceil(countChars(msg) / CHARS_PER_TOKEN);

const estimateChatTokens = (chat) =>
  (chat || []).reduce((sum, msg) => sum + estimateTokens(msg), 0);

const reportedTotal = (usage) => {
  if (!usage || typeof usage !== "object") return;
  for (const k of ["totalTokens", "total_tokens"])
    if (typeof usage[k] === "number") return usage[k];
  const inp = usage.inputTokens ?? usage.prompt_tokens;
  const out = usage.outputTokens ?? usage.completion_tokens;
  if (typeof inp === "number" && typeof out === "number") return inp + out;
};

/**
 * Size of the request the LLM is about to receive.
 *
 * The number the backend reported for the previous turn is the size of that
 * request plus the response that was appended to the chat, which is the best
 * available measure of what the next request costs. Only messages added since
 * that measurement have to be estimated. Backends that report no usage fall
 * back to a pure estimate of the whole chat.
 */
const estimateContextTokens = (chat, usage) => {
  const msgs = Array.isArray(chat) ? chat : [];
  const total = reportedTotal(usage);
  const measuredAt = usage?.at_message_count;
  if (
    typeof total !== "number" ||
    typeof measuredAt !== "number" ||
    // the chat has been compacted since the measurement, so it no longer
    // describes anything that is still in the chat
    measuredAt > msgs.length
  )
    return estimateChatTokens(msgs);
  return total + estimateChatTokens(msgs.slice(measuredAt));
};

const shouldCompact = (tokens, cfg, state, chatLength) => {
  if (tokens <= numOr(cfg?.trigger_tokens, DEFAULTS.trigger_tokens))
    return false;
  const since = state?.at_message_count;
  if (
    typeof since === "number" &&
    typeof chatLength === "number" &&
    chatLength - since < MIN_NEW_MESSAGES
  )
    return false;
  return true;
};

//
// ------------------------------------------------------- message inspection
//

const toolCallIdsIn = (msg) => {
  const ids = [];
  if (!msg || typeof msg !== "object") return ids;
  if (msg.type === "function_call" && msg.call_id) ids.push(msg.call_id);
  if (Array.isArray(msg.tool_calls))
    for (const tc of msg.tool_calls) if (tc?.id) ids.push(tc.id);
  if (Array.isArray(msg.content))
    for (const part of msg.content)
      if (part?.type === "tool-call" && part.toolCallId)
        ids.push(part.toolCallId);
  return ids;
};

const toolResultIdsIn = (msg) => {
  const ids = [];
  if (!msg || typeof msg !== "object") return ids;
  if (msg.type === "function_call_output" && msg.call_id) ids.push(msg.call_id);
  if (msg.role === "tool" && msg.tool_call_id) ids.push(msg.tool_call_id);
  if (Array.isArray(msg.content))
    for (const part of msg.content)
      if (
        (part?.type === "tool-result" || part?.type === "tool-error") &&
        part.toolCallId
      )
        ids.push(part.toolCallId);
  return ids;
};

const isToolResultMsg = (msg) => toolResultIdsIn(msg).length > 0;

const isUserMessage = (msg) => msg?.role === "user";

// The plain text of a message, ignoring tool calls and media.
const messageText = (msg) => {
  if (!msg || typeof msg !== "object") return "";
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((p) => p?.type === "text" || p?.type === "output_text")
    .map((p) => p.text || p.value || "")
    .join("\n");
};

const isSummaryMessage = (msg) => messageText(msg).includes(SUMMARY_OPEN);

const isAckMessage = (msg) =>
  msg?.role === "assistant" && messageText(msg).trim() === ACK_TEXT;

// The text of the current anchored summary, if the chat holds one.
const extractSummary = (chat) => {
  for (let i = (chat || []).length - 1; i >= 0; i--) {
    if (!isSummaryMessage(chat[i])) continue;
    const text = messageText(chat[i]);
    const from = text.indexOf(SUMMARY_OPEN) + SUMMARY_OPEN.length;
    const to = text.indexOf(SUMMARY_CLOSE);
    return (to > from ? text.slice(from, to) : text.slice(from)).trim();
  }
};

const lastSummaryIndex = (chat) => {
  for (let i = (chat || []).length - 1; i >= 0; i--)
    if (isSummaryMessage(chat[i])) return i;
  return -1;
};

//
// ------------------------------------------------------------- cut points
//

/**
 * Tool results in chat.slice(fromIdx) whose tool call is not also in that
 * slice. Sending one to the provider fails the request, so a cut that leaves
 * any behind is not usable.
 */
const orphanToolResults = (chat, fromIdx) => {
  const called = new Set();
  const orphans = [];
  for (let i = Math.max(0, fromIdx); i < (chat || []).length; i++) {
    for (const id of toolCallIdsIn(chat[i])) called.add(id);
    for (const id of toolResultIdsIn(chat[i]))
      if (!called.has(id)) orphans.push(id);
  }
  return orphans;
};

/**
 * How many messages at the head of the chat are always preserved verbatim:
 * everything up to and including the first user message - the chat sidebar
 * preview and the chat search read it, and it is the cheapest anchor for the
 * objective - extended forward over any tool calls it leaves unanswered.
 */
const headKeepCount = (chat) => {
  if (!(chat || []).length) return 0;
  let n = 0;
  while (n < chat.length && !isUserMessage(chat[n])) n++;
  // no user message at all: anchor on the first message
  n = n >= chat.length ? 1 : n + 1;
  const open = new Set();
  for (let i = 0; i < n; i++) {
    for (const id of toolResultIdsIn(chat[i])) open.delete(id);
    for (const id of toolCallIdsIn(chat[i])) open.add(id);
  }
  while (open.size && n < chat.length) {
    for (const id of toolResultIdsIn(chat[n])) open.delete(id);
    for (const id of toolCallIdsIn(chat[n])) open.add(id);
    n++;
  }
  return n;
};

// A cut at i drops the messages between the preserved head and i, and retains
// chat.slice(i).
const isValidCutPoint = (chat, i) =>
  i >= headKeepCount(chat) &&
  i <= (chat || []).length &&
  orphanToolResults(chat, i).length === 0;

/**
 * The index the retained tail starts at: walk back from the end until
 * keepRecentTokens is exceeded, then snap forward to a cut that does not
 * separate a tool result from its call. Returns chat.length when there is no
 * usable cut, which means "do not summarize".
 */
const findCutPoint = (chat, keepRecentTokens) => {
  const n = (chat || []).length;
  const minCut = headKeepCount(chat);
  let acc = 0;
  let cut = n;
  for (let i = n - 1; i >= minCut; i--) {
    acc += estimateTokens(chat[i]);
    // the newest message is retained however big it is
    if (acc > keepRecentTokens && cut < n) break;
    cut = i;
  }
  let firstValid;
  for (let i = cut; i < n; i++) {
    if (!isValidCutPoint(chat, i)) continue;
    if (typeof firstValid === "undefined") firstValid = i;
    if (isUserMessage(chat[i])) return i; // a turn boundary is preferred
    if (i - firstValid >= USER_SNAP_WINDOW) break;
  }
  if (typeof firstValid !== "undefined") return firstValid;
  // nothing valid ahead of the budget: cut further back instead, which retains
  // more than was asked for but is always safe
  for (let i = Math.min(cut, n) - 1; i >= minCut; i--)
    if (isValidCutPoint(chat, i)) return i;
  return n;
};

//
// ------------------------------------------------- clearing old tool output
//

const clearedToolResultMsg = (msg) => {
  if (msg.type === "function_call_output")
    return { ...msg, output: CLEARED_TEXT };
  if (msg.role === "tool" && typeof msg.tool_call_id === "string")
    return { ...msg, content: CLEARED_TEXT };
  if (Array.isArray(msg.content))
    return {
      ...msg,
      content: msg.content.map((part) =>
        part?.type === "tool-result"
          ? { ...part, output: { type: "text", value: CLEARED_TEXT } }
          : part?.type === "tool-error"
            ? { ...part, output: { type: "error-text", value: CLEARED_TEXT } }
            : part,
      ),
    };
  return msg;
};

const isClearedToolResult = (msg) => {
  if (!isToolResultMsg(msg)) return false;
  if (msg.output === CLEARED_TEXT || msg.content === CLEARED_TEXT) return true;
  if (Array.isArray(msg.content))
    return msg.content.every(
      (part) =>
        !["tool-result", "tool-error"].includes(part?.type) ||
        part.output?.value === CLEARED_TEXT,
    );
  return false;
};

// Ids of the tool calls made by the last message that made any: their results
// are what the model is working on right now and are never cleared.
const latestCallIds = (chat) => {
  for (let i = (chat || []).length - 1; i >= 0; i--) {
    const ids = toolCallIdsIn(chat[i]);
    if (ids.length) return new Set(ids);
  }
  return new Set();
};

/**
 * Replace the payload of old tool results with a placeholder, newest first,
 * keeping the tool call, the tool name and the call id so that the pairing
 * invariant holds and the model can still see what it did.
 *
 * Mutates `chat` in place - the array is the one that gets sent to the LLM -
 * by replacing message objects rather than editing them, so a shallow copy
 * taken beforehand is a faithful archive.
 */
const clearOldToolResults = (chat, cfg, opts = {}) => {
  const protectTokens = opts.force
    ? 0
    : numOr(
        cfg?.protect_tool_output_tokens,
        DEFAULTS.protect_tool_output_tokens,
      );
  const minClear = opts.force
    ? 0
    : numOr(cfg?.min_clear_tokens, DEFAULTS.min_clear_tokens);
  const working = latestCallIds(chat);
  // messages before the summary are the preserved head; there is nothing to
  // gain there and the summary marker must not be disturbed
  const floor = lastSummaryIndex(chat) + 1;

  let protectedTokens = 0;
  let tokensFreed = 0;
  const plan = [];
  for (let i = (chat || []).length - 1; i >= floor; i--) {
    const msg = chat[i];
    if (!isToolResultMsg(msg) || isClearedToolResult(msg)) continue;
    if (toolResultIdsIn(msg).some((id) => working.has(id))) continue;
    const tokens = estimateTokens(msg);
    if (protectedTokens < protectTokens) {
      protectedTokens += tokens;
      continue;
    }
    const cleared = clearedToolResultMsg(msg);
    const freed = tokens - estimateTokens(cleared);
    if (freed <= 0) continue;
    plan.push([i, cleared]);
    tokensFreed += freed;
  }
  if (tokensFreed < minClear) return { cleared: 0, tokensFreed: 0 };
  for (const [i, msg] of plan) chat[i] = msg;
  return { cleared: plan.length, tokensFreed };
};

//
// ------------------------------------------------------------ serialization
//

const truncate = (s, maxChars) =>
  s.length <= maxChars
    ? s
    : `${s.slice(0, maxChars)}… [truncated, ${s.length - maxChars} more characters]`;

// base64 payloads are worth nothing to the summarizer and would double the
// cost of the call that is meant to reduce it
const stripDataUrls = (s) =>
  s.replace(/data:[^;,\s"']{0,80};base64,[A-Za-z0-9+/=]+/g, "[media omitted]");

const asText = (v, maxChars) => {
  if (typeof v === "undefined" || v === null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return truncate(stripDataUrls(s || ""), maxChars);
};

// Tool output arrives wrapped as {type: "json"|"text", value}, and because the
// agent wraps it once before the LLM plugin wraps it again, often twice.
const unwrapToolOutput = (output) => {
  let v = output;
  for (let i = 0; i < 4; i++) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    if (!("value" in v) || typeof v.type !== "string") return v;
    v = v.value;
  }
  return v;
};

const toolOutputText = (output, maxChars) =>
  asText(unwrapToolOutput(output), maxChars);

const summaryLines = (msgs, cap) => {
  const lines = [];
  for (const msg of msgs || []) {
    if (!msg || typeof msg !== "object") continue;

    // OpenAI responses API
    if (msg.type === "function_call") {
      lines.push(
        `[Assistant tool call] ${msg.name}: ${asText(msg.arguments, cap)}`,
      );
      continue;
    }
    if (msg.type === "function_call_output") {
      lines.push(`[Tool result]: ${asText(msg.output, cap)}`);
      continue;
    }

    // OpenAI chat completions tool result
    if (msg.role === "tool" && typeof msg.tool_call_id === "string") {
      lines.push(`[Tool result]: ${asText(msg.content, cap)}`);
      continue;
    }

    const text = messageText(msg).trim();
    if (msg.role === "user") {
      if (text) lines.push(`[User]: ${stripDataUrls(text)}`);
    } else if (msg.role === "system") {
      if (text) lines.push(`[System]: ${stripDataUrls(text)}`);
    } else if (text) lines.push(`[Assistant]: ${stripDataUrls(text)}`);

    if (Array.isArray(msg.content))
      for (const part of msg.content) {
        if (isMediaPart(part)) lines.push(`[${msg.role}] [media omitted]`);
        else if (part?.type === "tool-call")
          lines.push(
            `[Assistant tool call] ${part.toolName}: ${asText(part.input, cap)}`,
          );
        else if (part?.type === "tool-result" || part?.type === "tool-error")
          lines.push(
            `[Tool result] ${part.toolName || ""}: ${toolOutputText(part.output, cap)}`,
          );
      }

    // OpenAI chat completions tool call
    if (Array.isArray(msg.tool_calls))
      for (const tc of msg.tool_calls)
        lines.push(
          `[Assistant tool call] ${tc?.function?.name || tc?.name || ""}: ${asText(
            tc?.function?.arguments ?? tc?.arguments,
            cap,
          )}`,
        );
  }
  return lines;
};

const totalChars = (lines) => lines.reduce((sum, l) => sum + l.length + 1, 0);

/**
 * Flatten messages to tagged plain text for the summarizer. Tool output is
 * truncated and media is replaced by a placeholder.
 *
 * The whole point of this call is that the context window is already full, so
 * the result also has to fit: if the per-result cap is not enough to get under
 * `totalMax`, the cap is tightened and then, as a last resort, the middle is
 * dropped - the start holds the objective and the end holds the recent work.
 */
const serializeForSummary = (msgs, maxChars, totalMax) => {
  const budget = numOr(totalMax, DEFAULTS.summary_input_max_chars);
  let cap = numOr(maxChars, DEFAULTS.tool_result_max_chars);
  let lines = summaryLines(msgs, cap);
  while (totalChars(lines) > budget && cap > MIN_TOOL_RESULT_CHARS) {
    cap = Math.max(MIN_TOOL_RESULT_CHARS, Math.floor(cap / 4));
    lines = summaryLines(msgs, cap);
  }
  if (totalChars(lines) <= budget) return lines.join("\n");

  const head = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > budget * 0.3) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail = [];
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (used + lines[i].length > budget) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  const dropped = lines.length - head.length - tail.length;
  return [
    ...head,
    `[… ${dropped} lines from the middle of the conversation omitted, they were too large to summarize …]`,
    ...tail,
  ].join("\n");
};

//
// ----------------------------------------------------------------- prompts
//

const SUMMARY_TEMPLATE = `## Objective
The task the user asked for, in their own terms.

## Key facts & constraints
Everything the assistant must not forget: rules, preferences, values, formats, limits.

## Completed
What has been done, with the outcome.

## In progress
What is being worked on right now, and how far it has got.

## Blocked
What could not be done, and why.

## Decisions
Choices that were made and the reason, so they are not revisited.

## Next steps
What remains to be done, in order.

## Relevant records & identifiers
Table names, row ids, file names, URLs, keys and other identifiers, copied exactly.`;

const COMPACTION_SYSTEM_PROMPT = `You are summarizing part of a conversation between a user and an AI assistant so that the assistant can carry on working after the earlier messages are removed from its context.

Write the summary for the assistant, not for the user. It is the only record of what happened, so it must be complete enough to continue the task without asking the user anything again.

Rules:
- Use exactly the section headings given, in that order, and include every section even if it is empty (write "None" under it).
- Copy identifiers - table names, field names, row ids, file names, URLs, numbers - verbatim. Never paraphrase, abbreviate or invent one.
- Record what was actually done and what was actually learned, including failures and dead ends, so they are not repeated.
- Prefer specifics over description. Do not write "the assistant looked at the data"; write what the data was.
- Do not address the user, do not comment on the summary, and do not add anything outside the sections.`;

const buildSummaryPrompt = (serialized, previousSummary, extraInstructions) => {
  const parts = [];
  if (previousSummary)
    parts.push(
      `A summary of the conversation before this point already exists:

<previous-summary>
${previousSummary}
</previous-summary>

Produce an updated summary that replaces it. Carry over every detail that is still true, move work that has since finished from In progress to Completed, and drop what no longer matters. The result must stand on its own: it replaces both the previous summary and the messages below.`,
    );
  else
    parts.push(
      "Summarize the conversation below. The result replaces these messages entirely.",
    );

  parts.push(`<conversation>
${serialized}
</conversation>`);

  if (extraInstructions)
    parts.push(`The user asked for the summary to focus on the following. Follow this in addition to the rules, never instead of them:

${extraInstructions}`);

  parts.push(`Use this template:

${SUMMARY_TEMPLATE}`);

  return parts.join("\n\n");
};

const summaryMessages = (summary) => [
  {
    role: "user",
    content: `The earlier part of this conversation has been removed to free up context. This is the record of it:

${SUMMARY_OPEN}
${summary}
${SUMMARY_CLOSE}

Continue the task from here, using the summary as if you remembered it.`,
  },
  { role: "assistant", content: ACK_TEXT },
];

//
// --------------------------------------------------------------- overflow
//

const OVERFLOW_RE =
  /context.{0,25}(length|window)|maximum context|context_length_exceeded|prompt is too long|too many tokens|exceeds?.{0,20}(token|context) limit/i;

const isContextOverflow = (err) => {
  if (!err) return false;
  if (typeof err === "string") return OVERFLOW_RE.test(err);
  const parts = [
    err.message,
    err.code,
    err.type,
    err.responseBody,
    err.body,
    err.error?.message,
    err.error?.code,
    err.data?.error?.message,
  ].filter((p) => typeof p === "string");
  return OVERFLOW_RE.test(parts.join(" "));
};

//
// ------------------------------------------------------------- compaction
//

/**
 * Shrink `chat` in place.
 *
 * `generate(prompt, opts)` performs the summarization call. `state` is the
 * previous run.context.compaction, `usage` the previous run.context.token_usage.
 * With `force`, the thresholds and the protected tool output are ignored - this
 * is the path taken after the provider has already rejected the request.
 *
 * The chat is never left in a state that cannot be sent to the LLM: if the
 * summarization fails, whatever the clearing pass achieved is kept and nothing
 * else changes.
 */
const compactChat = async ({
  chat,
  cfg = {},
  state,
  usage,
  generate,
  log = () => {},
  force = false,
}) => {
  const report = {
    compacted: false,
    cleared: 0,
    tokens_freed: 0,
    summarized: false,
    messages_removed: 0,
  };
  if (!Array.isArray(chat)) return { ...report, reason: "no chat" };

  const tokensBefore = estimateContextTokens(chat, usage);
  report.tokens_before = tokensBefore;
  report.tokens_after = tokensBefore;
  if (!force) {
    if (!shouldCompact(tokensBefore, cfg, state, chat.length))
      return { ...report, reason: "under threshold" };
  }

  let tokens = tokensBefore;
  if (clearsToolResults(cfg)) {
    const { cleared, tokensFreed } = clearOldToolResults(chat, cfg, { force });
    report.cleared = cleared;
    report.tokens_freed = tokensFreed;
    tokens -= tokensFreed;
    report.tokens_after = tokens;
    if (cleared)
      log(
        `Compaction cleared ${cleared} old tool results, freeing ~${tokensFreed} tokens`,
      );
  }
  report.compacted = report.cleared > 0;

  const trigger = numOr(cfg?.trigger_tokens, DEFAULTS.trigger_tokens);
  if (!summarizes(cfg))
    return {
      ...report,
      reason: report.compacted ? undefined : "nothing to clear",
    };
  if (!force && tokens <= trigger)
    return { ...report, reason: "clearing was enough" };
  if (typeof generate !== "function")
    return { ...report, reason: "no generate function" };

  const cut = findCutPoint(
    chat,
    numOr(cfg?.keep_recent_tokens, DEFAULTS.keep_recent_tokens),
  );
  const headStart = headKeepCount(chat);
  // a cut at the end of the chat means no cut was usable: retaining nothing is
  // never an option
  if (cut >= chat.length || cut <= headStart)
    return { ...report, reason: "no usable cut point" };
  const head = chat.slice(headStart, cut);
  // the previous summary is rewritten, not summarized again
  const toSummarize = head.filter(
    (msg, i) =>
      !isSummaryMessage(msg) &&
      !(isAckMessage(msg) && isSummaryMessage(head[i - 1])),
  );
  if (
    toSummarize.length < MIN_HEAD_MESSAGES ||
    estimateChatTokens(toSummarize) < MIN_HEAD_TOKENS
  )
    return { ...report, reason: "too little to summarize" };

  const previousSummary = extractSummary(chat) || state?.summary;
  const serialized = serializeForSummary(
    toSummarize,
    numOr(cfg?.tool_result_max_chars, DEFAULTS.tool_result_max_chars),
    numOr(cfg?.summary_input_max_chars, DEFAULTS.summary_input_max_chars),
  );
  const prompt = buildSummaryPrompt(
    serialized,
    previousSummary,
    cfg?.summary_instructions,
  );

  let summary;
  try {
    const answer = await generate(prompt, {
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
    });
    summary =
      typeof answer === "string" ? answer : answer?.content || answer?.text;
  } catch (e) {
    log(`Compaction summary failed: ${e?.message || e}`);
    return { ...report, reason: `summary failed: ${e?.message || e}` };
  }
  if (typeof summary !== "string" || !summary.trim())
    return { ...report, reason: "summary was empty" };
  summary = summary.trim();

  const inserted = summaryMessages(summary);
  chat.splice(headStart, cut - headStart, ...inserted);

  report.compacted = true;
  report.summarized = true;
  report.summary = summary;
  // what was handed to the summarizer, for the archive: already bounded
  report.serialized = serialized;
  report.messages_removed = cut - headStart - inserted.length;
  report.tokens_after = estimateChatTokens(chat);
  log(
    `Compaction summarized ${cut - headStart} messages, chat is now ~${report.tokens_after} tokens`,
  );
  return report;
};

module.exports = {
  ACK_TEXT,
  CLEARED_TEXT,
  COMPACTION_SYSTEM_PROMPT,
  DEFAULTS,
  SUMMARY_CLOSE,
  SUMMARY_OPEN,
  SUMMARY_TEMPLATE,
  buildSummaryPrompt,
  clearOldToolResults,
  compactChat,
  estimateChatTokens,
  estimateContextTokens,
  estimateTokens,
  extractSummary,
  findCutPoint,
  headKeepCount,
  isContextOverflow,
  isSummaryMessage,
  isValidCutPoint,
  messageText,
  orphanToolResults,
  serializeForSummary,
  shouldCompact,
  toolCallIdsIn,
  toolResultIdsIn,
};

const { getState } = require("@saltcorn/data/db/state");
const { afterAll, beforeAll, describe, it, expect } = require("@jest/globals");
const { mockReqRes } = require("@saltcorn/data/tests/mocks");

const {
  CLEARED_TEXT,
  SUMMARY_OPEN,
  buildSummaryPrompt,
  clearOldToolResults,
  compactChat,
  estimateChatTokens,
  estimateContextTokens,
  estimateTokens,
  extractSummary,
  findCutPoint,
  isContextOverflow,
  isSummaryMessage,
  isValidCutPoint,
  serializeForSummary,
  shouldCompact,
  toolResultIdsIn,
} = require("../skills/compaction_lib");
const {
  dropEmptyMessages,
  pendingToolCalls,
  process_interaction,
} = require("../common");
const CompactionSkill = require("../skills/Compaction");

/*

 RUN WITH:
  saltcorn dev:plugin-test -d ~/agents -o ~/large-language-model/

 The library tests need neither the database nor a model - `generate` is
 stubbed and every fixture is written by hand below - but the schema is reset
 anyway so that getState() behaves as it does in a running Saltcorn.

 */

afterAll(require("@saltcorn/data/db").close);
beforeAll(async () => {
  await require("@saltcorn/data/db/reset_schema")();
  await require("@saltcorn/data/db/fixtures")();
  getState().registerPlugin("base", require("@saltcorn/data/base-plugin"));
  await getState().setConfig("log_level", 1);
});

//
// ------------------------------------------------------------- fixtures
//

const big = (n) => "y".repeat(n);

// The same conversation in each of the three wire shapes the LLM backends
// use: a user question, two large tool results, a second turn, and a small
// recent tool result.
const fixtures = {
  "AI SDK": () => [
    { role: "user", content: "how many books are there?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "foo",
          input: { a: 1 },
        },
        {
          type: "tool-call",
          toolCallId: "c2",
          toolName: "bar",
          input: { b: 2 },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "foo",
          output: { type: "json", value: { rows: big(40000) } },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c2",
          toolName: "bar",
          output: { type: "text", value: big(40000) },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "there are 12" }] },
    { role: "user", content: "and how many authors?" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c3", toolName: "foo", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c3",
          toolName: "foo",
          output: { type: "text", value: "3 authors" },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "there are 3" }] },
  ],
  "OpenAI chat completions": () => [
    { role: "user", content: "how many books are there?" },
    {
      role: "assistant",
      content: "let me look",
      tool_calls: [
        { id: "c1", function: { name: "foo", arguments: '{"a":1}' } },
        { id: "c2", function: { name: "bar", arguments: '{"b":2}' } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: big(40000) },
    { role: "tool", tool_call_id: "c2", content: big(40000) },
    { role: "assistant", content: "there are 12" },
    { role: "user", content: "and how many authors?" },
    {
      role: "assistant",
      tool_calls: [{ id: "c3", function: { name: "foo", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "c3", content: "3 authors" },
    { role: "assistant", content: "there are 3" },
  ],
  "OpenAI responses": () => [
    { role: "user", content: "how many books are there?" },
    { type: "function_call", call_id: "c1", name: "foo", arguments: '{"a":1}' },
    { type: "function_call_output", call_id: "c1", output: big(40000) },
    { type: "function_call", call_id: "c2", name: "bar", arguments: '{"b":2}' },
    { type: "function_call_output", call_id: "c2", output: big(40000) },
    { role: "assistant", content: "there are 12" },
    { role: "user", content: "and how many authors?" },
    { type: "function_call", call_id: "c3", name: "foo", arguments: "{}" },
    { type: "function_call_output", call_id: "c3", output: "3 authors" },
    { role: "assistant", content: "there are 3" },
  ],
};

const eachShape = (name, f) => {
  for (const [shape, mkChat] of Object.entries(fixtures))
    it(`${name} (${shape})`, () => f(mkChat(), shape));
};

const eachShapeAsync = (name, f) => {
  for (const [shape, mkChat] of Object.entries(fixtures))
    it(`${name} (${shape})`, async () => await f(mkChat(), shape));
};

const summarizeOnly = {
  trigger_tokens: 1000,
  keep_recent_tokens: 100,
  strategy: "Summarize older messages",
};
const clearOnly = {
  trigger_tokens: 1000,
  strategy: "Clear old tool results",
  min_clear_tokens: 0,
  protect_tool_output_tokens: 0,
};

const stubSummary = async () => "## Objective\nCount the books";

// Writing past the end of the chat leaves holes, which reach the provider as
// undefined messages and are rejected before the request is made. Array
// methods skip holes, so the array has to be materialized to see them.
const holes = (chat) => Array.from(chat).filter((msg) => !msg).length;

//
// -------------------------------------------------------------- the tests
//

describe("token estimation", () => {
  it("is zero for an empty chat", () => {
    expect(estimateChatTokens([])).toBe(0);
    expect(estimateContextTokens([], null)).toBe(0);
    expect(estimateContextTokens([], { totalTokens: 500 })).toBe(0);
  });

  it("trusts the reported usage and adds only what came after it", () => {
    const chat = fixtures["AI SDK"]();
    const added = estimateChatTokens(chat.slice(4));
    expect(
      estimateContextTokens(chat, { totalTokens: 5000, at_message_count: 4 }),
    ).toBe(5000 + added);
    expect(added).toBeGreaterThan(0);
  });

  it("falls back to characters over four when there is no usage", () => {
    const chat = fixtures["AI SDK"]();
    const chars = JSON.stringify(chat).length;
    for (const usage of [null, undefined, {}, { at_message_count: 3 }]) {
      const est = estimateContextTokens(chat, usage);
      expect(est).toBe(estimateChatTokens(chat));
      expect(est).toBeGreaterThan((chars / 4) * 0.75);
      expect(est).toBeLessThan((chars / 4) * 1.25);
    }
  });

  it("ignores usage measured on a longer chat, which was compacted since", () => {
    const chat = fixtures["AI SDK"]();
    expect(
      estimateContextTokens(chat, {
        totalTokens: 500000,
        at_message_count: chat.length + 5,
      }),
    ).toBe(estimateChatTokens(chat));
  });

  it("counts an image flat rather than by its base64", () => {
    const image = (n) => ({
      role: "user",
      content: [{ type: "image", image: "A".repeat(n) }],
    });
    expect(estimateTokens(image(500000))).toBe(estimateTokens(image(10)));
    expect(estimateTokens(image(10))).toBeLessThan(1500);
  });
});

describe("compaction trigger", () => {
  it("fires above the threshold and not below it", () => {
    expect(shouldCompact(100001, { trigger_tokens: 100000 }, null, 50)).toBe(
      true,
    );
    expect(shouldCompact(100000, { trigger_tokens: 100000 }, null, 50)).toBe(
      false,
    );
    expect(shouldCompact(9, {}, null, 50)).toBe(false);
  });

  it("uses the default threshold when none is configured", () => {
    expect(shouldCompact(100001, {}, null, 50)).toBe(true);
    expect(shouldCompact(99999, {}, null, 50)).toBe(false);
  });

  it("does not fire again until new messages have been added", () => {
    const cfg = { trigger_tokens: 100 };
    expect(shouldCompact(5000, cfg, { at_message_count: 20 }, 20)).toBe(false);
    expect(shouldCompact(5000, cfg, { at_message_count: 20 }, 21)).toBe(false);
    expect(shouldCompact(5000, cfg, { at_message_count: 20 }, 22)).toBe(true);
  });
});

describe("cut points", () => {
  eachShape("never land on a tool result", (chat) => {
    for (const keep of [1, 10, 100, 1000, 5000, 20000, 100000]) {
      const cut = findCutPoint(chat, keep);
      expect(cut).toBeLessThan(chat.length);
      expect(toolResultIdsIn(chat[cut])).toEqual([]);
      expect(isValidCutPoint(chat, cut)).toBe(true);
      // the retained tail can be sent to the LLM on its own
      expect(pendingToolCalls(chat.slice(cut))).toEqual([]);
    }
  });

  eachShape("keep a smaller tail for a smaller budget", (chat) => {
    expect(findCutPoint(chat, 100)).toBeGreaterThanOrEqual(
      findCutPoint(chat, 50000),
    );
  });

  eachShape(
    "always retain the newest message, however small the budget",
    (chat) => {
      expect(findCutPoint(chat, 1)).toBe(chat.length - 1);
    },
  );

  eachShape("never cut into the preserved head", (chat) => {
    expect(findCutPoint(chat, 10 ** 9)).toBeGreaterThanOrEqual(1);
  });
});

describe("clearing old tool results", () => {
  eachShape("leaves the newest tool output alone", (chat) => {
    const before = JSON.parse(JSON.stringify(chat));
    clearOldToolResults(chat, {
      protect_tool_output_tokens: 0,
      min_clear_tokens: 0,
    });
    // the result answering the most recent tool call is never cleared
    const lastResult = chat.length - 2;
    expect(chat[lastResult]).toEqual(before[lastResult]);
    expect(JSON.stringify(chat)).toContain("3 authors");
  });

  eachShape("respects the protected tool output budget", (chat) => {
    const before = JSON.parse(JSON.stringify(chat));
    const { cleared } = clearOldToolResults(chat, {
      protect_tool_output_tokens: 10 ** 9,
      min_clear_tokens: 0,
    });
    expect(cleared).toBe(0);
    expect(chat).toEqual(before);
  });

  eachShape("keeps the tool call and the call ids", (chat) => {
    const before = JSON.parse(JSON.stringify(chat));
    const { cleared, tokensFreed } = clearOldToolResults(chat, {
      protect_tool_output_tokens: 0,
      min_clear_tokens: 0,
    });
    expect(cleared).toBeGreaterThan(0);
    expect(tokensFreed).toBeGreaterThan(10000);
    expect(JSON.stringify(chat)).toContain(CLEARED_TEXT);
    // the calls, and the pairing of every result with its call, are untouched
    expect(pendingToolCalls(chat)).toEqual([]);
    expect(chat.map(toolResultIdsIn)).toEqual(before.map(toolResultIdsIn));
    expect(JSON.stringify(chat)).toContain("foo");
    expect(estimateChatTokens(chat)).toBeLessThan(estimateChatTokens(before));
  });

  eachShape(
    "does not touch the chat when too little would be freed",
    (chat) => {
      const before = JSON.parse(JSON.stringify(chat));
      const res = clearOldToolResults(chat, {
        protect_tool_output_tokens: 0,
        min_clear_tokens: 10 ** 9,
      });
      expect(res).toEqual({ cleared: 0, tokensFreed: 0 });
      expect(chat).toEqual(before);
    },
  );

  it("does not clear across a summary boundary", () => {
    const oldResult = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "old",
          toolName: "foo",
          output: { type: "text", value: big(40000) },
        },
      ],
    };
    const chat = [
      { role: "user", content: "the original question" },
      oldResult,
      { role: "user", content: `x ${SUMMARY_OPEN}\nwhat happened\n` },
      { role: "assistant", content: "understood" },
      ...fixtures["AI SDK"]().slice(1),
    ];
    const { cleared } = clearOldToolResults(chat, {
      protect_tool_output_tokens: 0,
      min_clear_tokens: 0,
    });
    expect(cleared).toBeGreaterThan(0);
    // everything before the summary is left as it was
    expect(chat[1]).toEqual(oldResult);
  });
});

describe("serialization for the summarizer", () => {
  eachShape("truncates tool results", (chat) => {
    const out = serializeForSummary(chat, 100);
    expect(out).toContain("truncated");
    expect(out).not.toContain(big(200));
    expect(out.length).toBeLessThan(4000);
  });

  it("never emits base64", () => {
    const b64 = "iVBORw0KGgoAAAANSUhEUg" + "QUJTQUJTQUJT".repeat(200);
    const out = serializeForSummary(
      [
        { role: "user", content: "look" },
        { role: "user", content: [{ type: "image", image: b64 }] },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${b64}` },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c9",
              toolName: "screenshot",
              output: { type: "text", value: `data:image/png;base64,${b64}` },
            },
          ],
        },
      ],
      100000,
    );
    expect(out).not.toContain(b64);
    expect(out).not.toContain(b64.slice(0, 40));
    expect(out).toContain("[media omitted]");
  });

  eachShape("keeps the questions, the tool names and the answers", (chat) => {
    const out = serializeForSummary(chat, 2000);
    expect(out).toContain("how many books are there?");
    expect(out).toContain("and how many authors?");
    expect(out).toContain("foo");
    expect(out).toContain("3 authors");
  });

  it("stays within the total budget however large the conversation", () => {
    const chat = [];
    for (let i = 0; i < 200; i++)
      chat.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c" + i,
            toolName: "foo",
            output: { type: "text", value: big(20000) },
          },
        ],
      });
    const out = serializeForSummary(chat, 2000, 20000);
    expect(out.length).toBeLessThanOrEqual(21000);
    expect(out).toContain("omitted");
  });
});

describe("the summary prompt", () => {
  const sections = [
    "## Objective",
    "## Key facts & constraints",
    "## Completed",
    "## In progress",
    "## Blocked",
    "## Decisions",
    "## Next steps",
    "## Relevant records & identifiers",
  ];

  it("always asks for every section", () => {
    for (const section of sections)
      expect(buildSummaryPrompt("a conversation", null, null)).toContain(
        section,
      );
  });

  it("includes the previous summary only when there is one", () => {
    expect(buildSummaryPrompt("x", null, null)).not.toContain(
      "<previous-summary>",
    );
    const repeat = buildSummaryPrompt("x", "the old summary", null);
    expect(repeat).toContain("<previous-summary>");
    expect(repeat).toContain("the old summary");
  });

  it("passes the user's focus through", () => {
    expect(buildSummaryPrompt("x", null, "never lose the case ids")).toContain(
      "never lose the case ids",
    );
  });
});

describe("compacting a chat", () => {
  eachShapeAsync(
    "leaves a chat that can still be sent to the LLM",
    async (chat) => {
      const report = await compactChat({
        chat,
        cfg: summarizeOnly,
        generate: stubSummary,
      });
      expect(report.summarized).toBe(true);
      expect(pendingToolCalls(chat)).toEqual([]);
      expect(chat.filter(isSummaryMessage).length).toBe(1);
      expect(extractSummary(chat)).toBe("## Objective\nCount the books");
    },
  );

  eachShapeAsync("preserves the first user message", async (chat) => {
    const first = JSON.parse(JSON.stringify(chat[0]));
    await compactChat({ chat, cfg: summarizeOnly, generate: stubSummary });
    expect(chat[0]).toEqual(first);
    // the chat sidebar preview reads the first string content in the chat
    expect(chat.find((ix) => typeof ix?.content === "string").content).toBe(
      "how many books are there?",
    );
  });

  eachShapeAsync("clears tool results before summarizing", async (chat) => {
    const report = await compactChat({
      chat,
      cfg: { ...clearOnly, strategy: "Both", keep_recent_tokens: 100 },
      generate: async () => {
        throw new Error("should not be called");
      },
    });
    expect(report.cleared).toBeGreaterThan(0);
    expect(report.summarized).toBe(false);
    expect(report.reason).toBe("clearing was enough");
    expect(report.tokens_after).toBeLessThan(report.tokens_before);
  });

  eachShapeAsync("does nothing below the threshold", async (chat) => {
    const before = JSON.parse(JSON.stringify(chat));
    const report = await compactChat({
      chat,
      cfg: { trigger_tokens: 10 ** 9 },
      generate: stubSummary,
    });
    expect(report.compacted).toBe(false);
    expect(report.reason).toBe("under threshold");
    expect(chat).toEqual(before);
  });

  for (const [what, generate] of [
    [
      "throws",
      async () => {
        throw new Error("model is down");
      },
    ],
    ["returns nothing", async () => ""],
    ["returns null", async () => null],
    ["returns an object with no text", async () => ({})],
  ])
    it(`leaves the chat untouched when the summarizer ${what}`, async () => {
      const chat = fixtures["AI SDK"]();
      const before = JSON.parse(JSON.stringify(chat));
      const report = await compactChat({ chat, cfg: summarizeOnly, generate });
      expect(report.compacted).toBe(false);
      expect(report.reason).toBeTruthy();
      expect(chat).toEqual(before);
      expect(pendingToolCalls(chat)).toEqual([]);
    });

  it("keeps whatever clearing achieved when the summarizer fails", async () => {
    const chat = fixtures["AI SDK"]();
    const report = await compactChat({
      chat,
      cfg: {
        ...summarizeOnly,
        strategy: "Both",
        min_clear_tokens: 0,
        protect_tool_output_tokens: 0,
      },
      generate: async () => {
        throw new Error("model is down");
      },
    });
    expect(report.summarized).toBe(false);
    expect(report.cleared).toBeGreaterThan(0);
    expect(JSON.stringify(chat)).toContain(CLEARED_TEXT);
    expect(pendingToolCalls(chat)).toEqual([]);
  });

  it("rewrites the previous summary instead of stacking a new one", async () => {
    const chat = fixtures["AI SDK"]();
    await compactChat({ chat, cfg: summarizeOnly, generate: stubSummary });
    chat.push(
      { role: "user", content: "and the publishers? " + big(20000) },
      { role: "assistant", content: [{ type: "text", text: big(20000) }] },
      { role: "user", content: "and the editors? " + big(20000) },
      { role: "assistant", content: [{ type: "text", text: big(20000) }] },
    );
    let seen;
    const report = await compactChat({
      chat,
      cfg: summarizeOnly,
      generate: async (prompt) => {
        seen = prompt;
        return "## Objective\nCount everything";
      },
    });
    expect(report.summarized).toBe(true);
    expect(seen).toContain("<previous-summary>");
    expect(seen).toContain("## Objective\nCount the books");
    // the summary message itself is not fed back in as conversation
    expect(seen).not.toContain("has been removed to free up context");
    expect(seen).not.toContain("I have read the summary");
    expect(chat.filter(isSummaryMessage).length).toBe(1);
    expect(extractSummary(chat)).toBe("## Objective\nCount everything");
  });

  it("is a no-op when nothing has been added since the last compaction", async () => {
    const chat = fixtures["AI SDK"]();
    await compactChat({ chat, cfg: summarizeOnly, generate: stubSummary });
    const after = JSON.parse(JSON.stringify(chat));
    const report = await compactChat({
      chat,
      cfg: summarizeOnly,
      state: { at_message_count: chat.length },
      generate: async () => "a second summary",
    });
    expect(report.compacted).toBe(false);
    expect(chat).toEqual(after);
  });
});

describe("context overflow detection", () => {
  const overflows = [
    "This model's maximum context length is 128000 tokens, however you requested 130000 tokens",
    "context_length_exceeded",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "input length and `max_tokens` exceed context limit: 199000 + 8192 > 200000",
    "Requested token count exceeds the model's context window of 1048576",
    "The input token count exceeds the maximum number of tokens allowed",
  ];
  for (const message of overflows) {
    it(`recognises: ${message.slice(0, 45)}`, () => {
      expect(isContextOverflow(new Error(message))).toBe(true);
      expect(isContextOverflow(message)).toBe(true);
      expect(isContextOverflow({ error: { message } })).toBe(true);
      expect(isContextOverflow({ responseBody: message })).toBe(true);
    });
  }

  const others = [
    "Rate limit exceeded, please try again later",
    "401 Incorrect API key provided",
    "Table books does not exist",
    "The tool call was not completed.",
    "fetch failed",
  ];
  for (const message of others) {
    it(`does not misread: ${message.slice(0, 45)}`, () => {
      expect(isContextOverflow(new Error(message))).toBe(false);
    });
  }

  it("is false for nothing at all", () => {
    expect(isContextOverflow(null)).toBe(false);
    expect(isContextOverflow(undefined)).toBe(false);
    expect(isContextOverflow({})).toBe(false);
  });
});

//
// The skill itself, and the recovery path through process_interaction. The run
// is a plain object rather than a WorkflowRun: process_interaction only needs
// context and update, and this keeps the test away from the database.
//

const fakeRun = (interactions) => ({
  id: 1,
  updates: [],
  context: {
    interactions,
    html_interactions: [],
    funcalls: {},
    implemented_fcall_ids: [],
  },
  async update(what) {
    this.updates.push(what);
  },
});

describe("the Compaction skill", () => {
  const restore = getState().functions?.llm_generate;
  afterAll(() => {
    if (restore) getState().functions.llm_generate = restore;
  });

  it("offers configuration fields that Saltcorn can build a form from", async () => {
    const fields = await CompactionSkill.configFields();
    expect(fields.map((f) => f.name)).toContain("trigger_tokens");
    expect(fields.map((f) => f.name)).toContain("strategy");
    for (const field of fields) {
      expect(typeof field.name).toBe("string");
      expect(typeof field.label).toBe("string");
      expect(["String", "Integer", "Bool"]).toContain(field.type);
    }
  });

  it("compacts in place and records what it did on the run", async () => {
    const run = fakeRun(fixtures["AI SDK"]());
    const chat = run.context.interactions;
    const skill = new CompactionSkill({
      trigger_tokens: 1000,
      min_clear_tokens: 0,
      protect_tool_output_tokens: 0,
    });
    const report = await skill.beforeGenerate({
      run,
      chat,
      config: {},
      req: mockReqRes.req,
    });
    expect(report.compacted).toBe(true);
    // the same array the LLM is about to be sent, not a replacement
    expect(run.context.interactions).toBe(chat);
    expect(run.context.compaction.count).toBe(1);
    expect(run.context.compaction.tokens_after).toBeLessThan(
      run.context.compaction.tokens_before,
    );
    expect(run.updates.length).toBeGreaterThan(0);
    // the chat display is not touched, only a notice is added
    expect(run.context.html_interactions.length).toBe(1);
    expect(run.context.html_interactions[0]).toContain("Context shortened");
  });

  it("compacts on /compact and does not send the command to the model", async () => {
    const prompts = [];
    getState().functions.llm_generate = {
      run: async (prompt, opts) => {
        prompts.push({ prompt, opts });
        return "## Objective\nCount the books";
      },
    };
    const chat = fixtures["AI SDK"]();
    chat.push({ role: "user", content: "/compact keep the book ids" });
    const run = fakeRun(chat);
    const skill = new CompactionSkill({
      trigger_tokens: 10 ** 9, // far above the chat: only the command fires it
      strategy: "Summarize older messages",
    });
    const report = await skill.beforeGenerate({
      run,
      chat,
      config: {},
      req: mockReqRes.req,
    });
    expect(report.summarized).toBe(true);
    expect(prompts.length).toBe(1);
    expect(prompts[0].prompt).toContain("keep the book ids");
    expect(prompts[0].opts.systemPrompt).toContain("summarizing");
    expect(prompts[0].opts.tools).toBeUndefined();
    // summarizing shortens the chat, so the command is no longer where it was
    expect(holes(chat)).toBe(0);
    expect(JSON.stringify(chat)).not.toContain("/compact");
    const last = chat[chat.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).not.toContain("/compact");
    expect(extractSummary(chat)).toContain("Count the books");
  });

  it("replaces the /compact command when nothing was compacted", async () => {
    getState().functions.llm_generate = {
      run: async () => {
        throw new Error("should not be called");
      },
    };
    // nothing but plain messages, so there is no tool output to clear
    const chat = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hello, what can I do for you?" },
      { role: "user", content: "/compact" },
    ];
    const run = fakeRun(chat);
    const skill = new CompactionSkill({ strategy: "Clear old tool results" });
    const report = await skill.beforeGenerate({
      run,
      chat,
      config: {},
      req: mockReqRes.req,
    });
    expect(report.compacted).toBe(false);
    expect(holes(chat)).toBe(0);
    expect(JSON.stringify(chat)).not.toContain("/compact");
    expect(chat[chat.length - 1].content).toContain("not enough to shorten");
  });

  it("summarizes with the configured alternative configuration", async () => {
    const seen = [];
    getState().functions.llm_generate = {
      run: async (prompt, opts) => {
        seen.push(opts);
        return "## Objective\nx";
      },
    };
    const chat = fixtures["AI SDK"]();
    const run = fakeRun(chat);
    const skill = new CompactionSkill({
      ...summarizeOnly,
      summary_alt_config: "cheap",
      summary_model: "small-model",
    });
    await skill.beforeGenerate({
      run,
      chat,
      config: { alt_config: "expensive", model: "big-model" },
      req: mockReqRes.req,
    });
    expect(seen[0].alt_config).toBe("cheap");
    expect(seen[0].model).toBe("small-model");
  });
});

describe("recovery from a context overflow", () => {
  const config = {
    skills: [
      {
        skill_type: "Compaction",
        trigger_tokens: 10 ** 9, // never compacts proactively
        min_clear_tokens: 0,
        protect_tool_output_tokens: 0,
      },
    ],
  };
  const overflow = () =>
    new Error(
      "This model's maximum context length is 128000 tokens, however you requested 200000 tokens",
    );

  it("compacts and retries the turn exactly once", async () => {
    let calls = 0;
    getState().functions.llm_generate = {
      run: async () => {
        calls += 1;
        throw overflow();
      },
    };
    const run = fakeRun(fixtures["AI SDK"]());
    await expect(
      process_interaction(run, config, mockReqRes.req),
    ).rejects.toThrow(/maximum context length/);
    expect(calls).toBe(2);
    expect(JSON.stringify(run.context.interactions)).toContain(CLEARED_TEXT);
    expect(typeof run.context.compaction.overflow_recovered_at).toBe("number");
  });

  it("carries on when the retry succeeds", async () => {
    let calls = 0;
    getState().functions.llm_generate = {
      run: async () => {
        calls += 1;
        if (calls === 1) throw overflow();
        return "there are 12 books";
      },
    };
    const run = fakeRun(fixtures["AI SDK"]());
    const result = await process_interaction(run, config, mockReqRes.req);
    expect(calls).toBe(2);
    expect(result.json.success).toBe("ok");
    expect(result.json.response).toContain("there are 12 books");
  });

  it("does not retry an error that is not an overflow", async () => {
    let calls = 0;
    getState().functions.llm_generate = {
      run: async () => {
        calls += 1;
        throw new Error("401 Incorrect API key provided");
      },
    };
    const run = fakeRun(fixtures["AI SDK"]());
    await expect(
      process_interaction(run, config, mockReqRes.req),
    ).rejects.toThrow(/Incorrect API key/);
    expect(calls).toBe(1);
  });

  it("does not retry when no skill can compact anything", async () => {
    let calls = 0;
    getState().functions.llm_generate = {
      run: async () => {
        calls += 1;
        throw overflow();
      },
    };
    const run = fakeRun([{ role: "user", content: "hello" }]);
    await expect(
      process_interaction(run, { skills: [] }, mockReqRes.req),
    ).rejects.toThrow(/maximum context length/);
    expect(calls).toBe(1);
  });
});

//
// Continuing a run that was compacted. A chat is shortened in place, so an
// index taken before the compaction points past the end of it afterwards, and
// writing there leaves holes. They survive into the database as nulls, the
// provider is sent one message per entry, and the run can never be chatted
// with again - the reported symptom is a TypeError reading a property of null
// while the request is being built.
//

describe("continuing a compacted chat", () => {
  const restore = getState().functions?.llm_generate;
  afterAll(() => {
    if (restore) getState().functions.llm_generate = restore;
  });

  // A chat that has been summarized: the first user message, the summary and
  // its acknowledgement, then the retained tail.
  const compactedChat = () => [
    { role: "user", content: "how many books are there?" },
    {
      role: "user",
      content: `The earlier part of this conversation has been removed to free up context. This is the record of it:\n\n${SUMMARY_OPEN}\n## Objective\nCount the books\n</conversation-summary>\n\nContinue the task from here.`,
    },
    {
      role: "assistant",
      content: "I have read the summary of the earlier conversation",
    },
    { role: "user", content: "and how many authors?" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c9", toolName: "foo", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c9",
          toolName: "foo",
          output: { type: "text", value: "3 authors" },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "there are 3" }] },
  ];

  // How the holes are made: an index taken before the chat was shortened.
  const withHoleAt = (chat, at, msg) => {
    chat[at] = msg;
    return chat;
  };

  // What the run looks like when it is read back: a hole is stored as a null.
  const asStored = (chat) => JSON.parse(JSON.stringify(chat));

  it("stores a hole as a null message", () => {
    const chat = withHoleAt(compactedChat(), 12, {
      role: "user",
      content: "carry on",
    });
    expect(holes(chat)).toBe(5);
    const stored = asStored(chat);
    expect(stored.length).toBe(13);
    expect(stored[7]).toBe(null);
    expect(holes(stored)).toBe(5);
  });

  const askAgain = async (chat) => {
    const sent = [];
    getState().functions.llm_generate = {
      run: async (prompt, opts) => {
        // what the LLM plugin would hand to the provider
        sent.push(Array.from(opts.chat || []));
        return "there are 12 books";
      },
    };
    const run = fakeRun(chat);
    const result = await process_interaction(
      run,
      { skills: [] },
      mockReqRes.req,
    );
    return { run, result, sent };
  };

  it("answers when the stored chat has nulls in it", async () => {
    const stored = asStored(
      withHoleAt(compactedChat(), 12, {
        role: "user",
        content: "does it rain more in spain or in france?",
      }),
    );
    const { run, result, sent } = await askAgain(stored);

    expect(result.json.success).toBe("ok");
    expect(result.json.response).toContain("there are 12 books");
    // nothing empty ever reaches the model
    expect(sent.length).toBe(1);
    expect(holes(sent[0])).toBe(0);
    expect(sent[0].length).toBe(8);
    // and what was in the chat is still there, in order
    expect(extractSummary(sent[0])).toContain("Count the books");
    expect(sent[0][sent[0].length - 1].content).toContain("rain more in spain");
    expect(pendingToolCalls(sent[0])).toEqual([]);
    // the run is repaired for good, not just for this turn
    expect(holes(run.context.interactions)).toBe(0);
    const saved = run.updates.filter((u) => u.context);
    expect(saved.length).toBeGreaterThan(0);
    expect(holes(saved[saved.length - 1].context.interactions)).toBe(0);
  });

  it("answers when the chat still has the holes rather than nulls", async () => {
    const { result, sent } = await askAgain(
      withHoleAt(compactedChat(), 12, { role: "user", content: "carry on" }),
    );
    expect(result.json.success).toBe("ok");
    expect(holes(sent[0])).toBe(0);
    expect(sent[0][sent[0].length - 1].content).toBe("carry on");
  });

  it("does not separate a tool result from its call", async () => {
    // the hole falls between the call and its result
    const chat = compactedChat();
    const [call, result] = chat.splice(4, 2);
    chat.push(call, null, result);
    const { sent } = await askAgain(asStored(chat));
    expect(holes(sent[0])).toBe(0);
    expect(pendingToolCalls(sent[0])).toEqual([]);
    expect(toolResultIdsIn(sent[0][sent[0].length - 1])).toEqual(["c9"]);
  });

  it("leaves a chat with nothing wrong with it alone", async () => {
    const run = fakeRun(compactedChat());
    expect(await dropEmptyMessages(run)).toBe(false);
    expect(run.updates.length).toBe(0);
    expect(run.context.interactions.length).toBe(7);
  });

  it("copes with a run that has no chat at all", async () => {
    const run = fakeRun(undefined);
    expect(await dropEmptyMessages(run)).toBe(false);
  });
});

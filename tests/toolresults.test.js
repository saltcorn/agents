const { describe, it, expect } = require("@saltcorn/db-common/test_expect");

const { pendingToolCalls, toolResponseMessage } = require("../common");

describe("pendingToolCalls", () => {
  it("finds unanswered AI SDK tool calls", () => {
    const chat = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c1", toolName: "foo" },
          { type: "tool-call", toolCallId: "c2", toolName: "bar" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "foo",
            output: {},
          },
        ],
      },
    ];
    expect(pendingToolCalls(chat)).toEqual([
      { tool_call_id: "c2", tool_name: "bar", index: 1 },
    ]);
  });

  it("finds unanswered OpenAI tool calls", () => {
    const chat = [
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", function: { name: "foo" } },
          { id: "c2", function: { name: "bar" } },
        ],
      },
      { role: "tool", tool_call_id: "c2", content: "done" },
    ];
    expect(pendingToolCalls(chat)).toEqual([
      { tool_call_id: "c1", tool_name: "foo", index: 0 },
    ]);
  });

  it("finds unanswered responses API tool calls", () => {
    const chat = [
      { type: "function_call", call_id: "c1", name: "foo" },
      { type: "function_call_output", call_id: "c1", output: "done" },
      { type: "function_call", call_id: "c2", name: "bar" },
    ];
    expect(pendingToolCalls(chat)).toEqual([
      { tool_call_id: "c2", tool_name: "bar", index: 2 },
    ]);
  });

  it("is empty when every call is answered", () => {
    const chat = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "foo" }],
      },
      {
        role: "tool",
        content: [{ type: "tool-error", toolCallId: "c1", toolName: "foo" }],
      },
      { role: "assistant", content: [{ type: "text", text: "bye" }] },
    ];
    expect(pendingToolCalls(chat)).toEqual([]);
  });
});

describe("toolResponseMessage", () => {
  it("passes small results through", () => {
    expect(toolResponseMessage("hi")).toEqual({ type: "text", value: "hi" });
    expect(toolResponseMessage(undefined)).toEqual({
      type: "text",
      value: "Action run",
    });
    expect(toolResponseMessage({ rows: [{ id: 1 }] })).toEqual({
      type: "json",
      value: { rows: [{ id: 1 }] },
    });
  });

  it("truncates a huge text result", () => {
    const msg = toolResponseMessage("x".repeat(1000000), 5000);
    expect(msg.type).toBe("text");
    expect(msg.value.length).toBeLessThan(5300);
    expect(msg.value).toContain("Result truncated");
    expect(msg.value).toContain("1000000 characters");
  });

  it("truncates a huge JSON result to text", () => {
    const rows = Array.from({ length: 20000 }, (_, id) => ({ id, name: "n" }));
    const msg = toolResponseMessage({ rows }, 5000);
    expect(msg.type).toBe("text");
    expect(msg.value.startsWith('{"rows":[{"id":0')).toBe(true);
    expect(msg.value.length).toBeLessThan(5300);
  });

  it("uses the default cap when none is configured", () => {
    const msg = toolResponseMessage("x".repeat(3000000));
    expect(msg.value.length).toBeLessThan(100300);
  });
});

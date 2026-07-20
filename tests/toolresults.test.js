const { describe, it, expect } = require("@jest/globals");

const { pendingToolCalls } = require("../common");

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

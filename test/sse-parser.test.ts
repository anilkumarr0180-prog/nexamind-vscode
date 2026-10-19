import assert from "node:assert";
import { NexaMindClient, type StreamCallbacks } from "../src/client/nexamind.client";
import type { AgentPlan } from "../src/types";

export function runSSEParserTests(): void {
  console.log("[Test Suite] SSE Stream Event Parsing");

  // Create client with mock auth manager
  const mockAuth: any = { getToken: async () => "mock-token" };
  const client = new NexaMindClient(mockAuth);

  const captured: Record<string, any> = {};

  const callbacks: StreamCallbacks = {
    onStart: (ev) => { captured.start = ev; },
    onStatus: (status, message) => { captured.status = { status, message }; },
    onPlan: (plan: AgentPlan) => { captured.plan = plan; },
    onToolStatus: (ev) => { captured.toolStatus = ev; },
    onTrace: (trace) => { captured.trace = trace; },
    onChunk: (chunk) => { captured.chunk = (captured.chunk || "") + chunk; },
    onSources: (sources) => { captured.sources = sources; },
    onDone: (res) => { captured.done = res; },
    onAborted: (res) => { captured.aborted = res || true; },
    onError: (err: Error) => { captured.error = err.message; },
  };

  // 1. Dispatch "start"
  client.dispatchSSEEvent(
    JSON.stringify({ type: "start", conversationId: "651f8a7e2b14c8109d3e5210" }),
    callbacks,
  );
  assert.strictEqual(captured.start?.conversationId, "651f8a7e2b14c8109d3e5210");

  // 2. Dispatch "status"
  client.dispatchSSEEvent(
    JSON.stringify({ type: "status", status: "running", message: "Analyzing code..." }),
    callbacks,
  );
  assert.strictEqual(captured.status?.status, "running");
  assert.strictEqual(captured.status?.message, "Analyzing code...");

  // 3. Dispatch "plan"
  client.dispatchSSEEvent(
    JSON.stringify({
      type: "plan",
      plan: {
        steps: [
          { id: "1", title: "Analyze auth middleware", status: "completed" },
          { id: "2", title: "Generate explanation", status: "running" },
        ],
      },
    }),
    callbacks,
  );
  assert.strictEqual(captured.plan?.steps.length, 2);
  assert.strictEqual(captured.plan.steps[0].status, "completed");

  // 4. Dispatch "tool_status"
  client.dispatchSSEEvent(
    JSON.stringify({
      type: "tool_status",
      status: "running",
      tool: "web_search",
      toolCallId: "tc_123",
      durationMs: 45,
    }),
    callbacks,
  );
  assert.strictEqual(captured.toolStatus?.tool, "web_search");
  assert.strictEqual(captured.toolStatus?.status, "running");
  assert.strictEqual(captured.toolStatus?.toolCallId, "tc_123");
  assert.strictEqual(captured.toolStatus?.durationMs, 45);

  // 5. Dispatch "trace" (regression check: trace is dispatched and not ignored)
  client.dispatchSSEEvent(
    JSON.stringify({
      type: "trace",
      trace: {
        step: 1,
        type: "tool_call",
        tool: "web_search",
        status: "running",
        timestamp: "2026-10-15T09:00:00.000Z",
      },
    }),
    callbacks,
  );
  assert.notStrictEqual(captured.trace, undefined, "Trace payload must not be ignored");
  assert.strictEqual(captured.trace?.step, 1);
  assert.strictEqual(captured.trace?.tool, "web_search");
  assert.strictEqual(captured.trace?.type, "tool_call");

  // 6. Dispatch "chunk"
  client.dispatchSSEEvent(
    JSON.stringify({ type: "chunk", content: "The middleware " }),
    callbacks,
  );
  client.dispatchSSEEvent(
    JSON.stringify({ type: "chunk", content: "validates the token." }),
    callbacks,
  );
  assert.strictEqual(captured.chunk, "The middleware validates the token.");

  // 7. Dispatch "sources"
  client.dispatchSSEEvent(
    JSON.stringify({
      type: "sources",
      sources: [{ title: "Express Docs", url: "https://expressjs.com" }],
    }),
    callbacks,
  );
  assert.strictEqual(captured.sources?.length, 1);
  assert.strictEqual(captured.sources[0].title, "Express Docs");

  // 8. Dispatch "done"
  client.dispatchSSEEvent(
    JSON.stringify({
      type: "done",
      data: {
        executionId: "exec_1",
        userId: "user_1",
        task: "Explain auth",
        status: "completed",
        output: "The middleware validates the token.",
        stepsCompleted: 2,
      },
    }),
    callbacks,
  );
  assert.strictEqual(captured.done?.status, "completed");
  assert.strictEqual(captured.done?.output, "The middleware validates the token.");

  // 9. Dispatch "aborted"
  client.dispatchSSEEvent(
    JSON.stringify({
      type: "aborted",
      data: {
        executionId: "exec_1",
        userId: "user_1",
        task: "Explain auth",
        status: "cancelled",
        output: null,
        stepsCompleted: 1,
      },
    }),
    callbacks,
  );
  assert.notStrictEqual(captured.aborted, undefined);
  assert.strictEqual(captured.aborted?.status, "cancelled");

  // 10. Dispatch "error"
  client.dispatchSSEEvent(
    JSON.stringify({
      type: "error",
      error: { message: "Context window exceeded", code: "CONTEXT_EXCEEDED", statusCode: 400 },
    }),
    callbacks,
  );
  assert.strictEqual(captured.error, "Context window exceeded");

  // Regression test: Verify that omitting onTrace does not throw an error
  const callbacksWithoutTrace: StreamCallbacks = {
    onChunk: () => {},
  };
  assert.doesNotThrow(() => {
    client.dispatchSSEEvent(
      JSON.stringify({
        type: "trace",
        trace: { step: 2, type: "final_response" },
      }),
      callbacksWithoutTrace,
    );
  }, "Dispatching trace when onTrace is undefined should gracefully succeed without throwing");

  console.log("  ✓ All 10 backend SSE event types tested and verified successfully.");
}

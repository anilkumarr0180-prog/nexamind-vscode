import { randomUUID } from "crypto";
import { getConfig } from "../config";
import type { AuthManager } from "../auth/auth.manager";
import type {
  AgentPlan,
  AgentExecutionResult,
  ExecuteAgentRequestBody,
  SSEEvent,
} from "../types";

export interface StreamCallbacks {
  onStart?: (event: { conversationId?: string }) => void;
  onStatus?: (status: string, message: string) => void;
  onPlan?: (plan: AgentPlan) => void;
  onToolStatus?: (event: {
    status: "running" | "completed" | "failed";
    tool?: string;
    toolCallId?: string;
    durationMs?: number;
    error?: string;
  }) => void;
  onTrace?: (trace: unknown) => void;
  onChunk?: (chunk: string) => void;
  onSources?: (sources: Array<{ title?: string; url?: string; content?: string }>) => void;
  onDone?: (result: AgentExecutionResult) => void;
  onAborted?: (result?: AgentExecutionResult) => void;
  onError?: (error: Error) => void;
}

/**
 * NexaMind API Client for VS Code Extension.
 * Communicates with the existing NexaMind Backend Agent via POST /api/v1/agent/stream
 * without creating a second AgentLoop, provider, or tool registry.
 */
export class NexaMindClient {
  constructor(private readonly authManager: AuthManager) {}

  /**
   * Streams an agent task execution from the backend with progressive SSE event parsing.
   */
  public async executeStream(
    body: ExecuteAgentRequestBody,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const token = await this.authManager.getToken();
    if (!token) {
      const err = new Error("Authentication required. Please run 'NexaMind: Login / Configure Token'.");
      callbacks.onError?.(err);
      throw err;
    }

    const { apiUrl } = getConfig();
    const url = `${apiUrl}/agent/stream`;

    const idempotencyKey = body.idempotencyKey || `vscode_${randomUUID()}`;

    // Request payload strictly matches executeAgentSchema:
    // task, conversationId, systemPrompt, maxSteps, context, stream, idempotencyKey
    const requestPayload: ExecuteAgentRequestBody = {
      task: body.task.trim(),
      conversationId: body.conversationId,
      systemPrompt: body.systemPrompt,
      maxSteps: body.maxSteps,
      context: body.context,
      stream: true,
      idempotencyKey,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(requestPayload),
        signal,
      });
    } catch (fetchErr: unknown) {
      if (signal?.aborted) {
        callbacks.onAborted?.();
        return;
      }
      const err = new Error(
        `Failed to reach NexaMind API at ${apiUrl}: ${
          fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        }`,
      );
      callbacks.onError?.(err);
      throw err;
    }

    if (response.status === 401) {
      const renewedToken = await this.authManager.refreshSession();
      if (renewedToken) {
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
              Authorization: `Bearer ${renewedToken}`,
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify(requestPayload),
            signal,
          });
        } catch (retryErr: unknown) {
          if (signal?.aborted) {
            callbacks.onAborted?.();
            return;
          }
          throw retryErr;
        }
      }
    }

    if (!response.ok) {
      let message = `NexaMind API error (HTTP ${response.status})`;
      if (response.status === 401) {
        message =
          "Session expired or invalid. NexaMind tokens expire after 15 minutes. Please log in again.";
      } else if (response.status === 402) {
        message = "Insufficient credit balance. Please replenish your NexaMind credits.";
      } else if (response.status === 409) {
        message = "Another generation is already in progress for this conversation.";
      } else {
        try {
          const errJson = (await response.json()) as any;
          message = errJson.error?.message || errJson.message || message;
        } catch {
          // Keep fallback message
        }
      }

      const err = new Error(message);
      callbacks.onError?.(err);
      throw err;
    }

    if (!response.body) {
      const err = new Error("No response body received from NexaMind streaming server.");
      callbacks.onError?.(err);
      throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        if (signal?.aborted) {
          callbacks.onAborted?.();
          break;
        }

        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) {
            continue;
          }

          for (const line of trimmed.split("\n")) {
            if (line.startsWith("data: ")) {
              const jsonStr = line.slice(6).trim();
              this.dispatchSSEEvent(jsonStr, callbacks);
            }
          }
        }
      }
    } catch (streamErr: unknown) {
      if (signal?.aborted) {
        callbacks.onAborted?.();
        return;
      }
      const err =
        streamErr instanceof Error
          ? streamErr
          : new Error(`Stream read error: ${String(streamErr)}`);
      callbacks.onError?.(err);
      throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }

  /**
   * Dispatches parsed SSE event payloads to corresponding callback listeners.
   */
  public dispatchSSEEvent(jsonStr: string, callbacks: StreamCallbacks): void {
    if (!jsonStr) {
      return;
    }

    try {
      const payload = JSON.parse(jsonStr) as SSEEvent;
      switch (payload.type) {
        case "start":
          callbacks.onStart?.({ conversationId: payload.conversationId });
          break;
        case "status":
          callbacks.onStatus?.(payload.status, payload.message);
          break;
        case "plan":
          callbacks.onPlan?.(payload.plan);
          break;
        case "tool_status":
          callbacks.onToolStatus?.({
            status: payload.status,
            tool: payload.tool,
            toolCallId: payload.toolCallId,
            durationMs: payload.durationMs,
            error: payload.error,
          });
          break;
        case "trace":
          if (payload.trace !== undefined) {
            callbacks.onTrace?.(payload.trace);
          } else {
            callbacks.onTrace?.(payload);
          }
          break;
        case "chunk":
          if (payload.content) {
            callbacks.onChunk?.(payload.content);
          }
          break;
        case "sources":
          if (payload.sources) {
            callbacks.onSources?.(payload.sources);
          }
          break;
        case "done":
          callbacks.onDone?.(payload.data);
          break;
        case "aborted":
          callbacks.onAborted?.(payload.data);
          break;
        case "error":
          callbacks.onError?.(
            new Error(payload.error?.message || "Agent execution failed on backend"),
          );
          break;
      }
    } catch (parseErr) {
      // Ignore partial chunks or malformed non-JSON lines
    }
  }
}

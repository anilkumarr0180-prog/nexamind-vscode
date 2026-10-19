/**
 * NexaMind VS Code Extension Core Type Definitions
 * Reuses audited backend Agent interfaces and schemas without duplicating execution logic.
 */

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  tool?: string;
  error?: string;
}

export interface AgentPlan {
  steps: PlanStep[];
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  status: "executing" | "success" | "error";
  durationMs?: number;
  error?: string;
  result?: unknown;
}

export interface AgentExecutionResult {
  executionId: string;
  userId: string;
  task: string;
  status: "running" | "completed" | "failed" | "cancelled";
  output: string | null;
  stepsCompleted: number;
  toolCalls?: ToolCallInfo[];
  trace?: unknown[];
  sources?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
  plan?: AgentPlan;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  durationMs?: number;
  conversationId?: string;
  error?: string;
}

/**
 * Server-Sent Event (SSE) payloads emitted by POST /api/v1/agent/stream
 */
export type SSEEvent =
  | { type: "start"; conversationId?: string; userMessage?: unknown }
  | { type: "status"; status: string; message: string }
  | { type: "plan"; plan: AgentPlan }
  | {
      type: "tool_status";
      status: "running" | "completed" | "failed";
      tool?: string;
      toolCallId?: string;
      durationMs?: number;
      error?: string;
    }
  | { type: "trace"; trace: unknown }
  | { type: "sources"; sources: Array<{ title?: string; url?: string; content?: string }> }
  | { type: "chunk"; content: string }
  | { type: "done"; data: AgentExecutionResult }
  | { type: "aborted"; data?: AgentExecutionResult }
  | {
      type: "error";
      error: { message: string; code?: string; statusCode?: number };
      data?: AgentExecutionResult;
    };

/**
 * Strict request body schema required by NexaMind backend executeAgentSchema.
 * Note: Body schema is .strict(); workspace data MUST be nested within context.
 */
export interface ExecuteAgentRequestBody {
  task: string;
  conversationId?: string;
  systemPrompt?: string;
  maxSteps?: number;
  context?: Record<string, unknown>;
  stream?: boolean;
  idempotencyKey?: string;
}

export interface NexamindUser {
  id: string;
  email: string;
  name?: string;
  roles: string[];
}

export interface SelectionContext {
  text: string;
  startLine: number;
  endLine: number;
  language: string;
  relativePath: string;
}

export interface FileExcerpt {
  relativePath: string;
  language: string;
  content: string;
  totalLines: number;
  isTruncated: boolean;
}

export interface DiagnosticInfo {
  message: string;
  line: number;
  severity: "error" | "warning" | "info" | "hint";
  source?: string;
}

export interface WorkspaceContextPayload {
  workspaceName?: string;
  activeFile?: FileExcerpt;
  selection?: SelectionContext;
  diagnostics?: DiagnosticInfo[];
  timestamp: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  plan?: AgentPlan;
  activeStatus?: string;
  sources?: Array<{ title?: string; url?: string }>;
  proposal?: {
    id: string;
    files: string[];
    status: "pending" | "applied" | "rejected" | "stale";
    errorMessage?: string;
  };
  proposalError?: string;
  isStreaming?: boolean;
  isError?: boolean;
}

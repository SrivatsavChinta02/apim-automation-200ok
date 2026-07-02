const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:5050";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type PlanStep = {
  action: string;
  label: string;
  endpoint: string;
  payload: Record<string, unknown>;
  bulk?: boolean;
};

export type Plan = {
  template_id: string;
  name: string;
  mode: string;
  gate_required: boolean;
  steps: PlanStep[];
  summary: string;
};

export type ParseResponse =
  | { status: "ok"; plan: Plan; intent: string[]; params: Record<string, unknown> }
  | { status: "needs_params"; missing: string[]; intent: string[]; params: Record<string, unknown> }
  | { status: "invalid_params"; invalid: string[]; intent: string[]; params: Record<string, unknown> }
  | { status: "no_match"; intent: string[]; params: Record<string, unknown> }
  | { status: "off_topic"; intent: string[] }
  | { status: "analyze"; query: string; intent: string[] }
  | { status: "error"; message: string };

export async function parseQuery(query: string, history: ChatMessage[]): Promise<ParseResponse> {
  const res = await fetch(`${BACKEND_URL}/api/assistant/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, history }),
  });
  return res.json();
}

/** Runs a single plan step. Backend either returns plain JSON or an SSE
 * event-stream (progress events) — callers get every event via onEvent
 * and the promise resolves once the stream/request finishes. */
export async function runStep(
  step: PlanStep,
  onEvent: (event: unknown) => void
): Promise<void> {
  const res = await fetch(`${BACKEND_URL}${step.endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(step.payload),
  });

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    await consumeSSE(res, onEvent);
  } else {
    onEvent(await res.json());
  }
}

export type AnalyzeEvent =
  | { event: "started"; data: { session_id: string } }
  | { event: "tool_call_start"; data: { id: string; tool: string; args: unknown } }
  | { event: "tool_call_done"; data: { id: string; tool: string; args: unknown; summary: string; duration_ms: number } }
  | { event: "tool_confirmation_required"; data: { batch_id: string; tools: Array<{ tool_use_id: string; name: string; args: unknown; mutates: boolean; requires_password: boolean; preview: string }>; requires_password: boolean } }
  | { event: "final_answer"; data: { text: string } }
  | { event: "error"; data: { message: string } };

export async function streamAnalyze(
  query: string,
  history: ChatMessage[],
  sessionId: string,
  onEvent: (event: AnalyzeEvent) => void
): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/assistant/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, history, session_id: sessionId }),
  });
  await consumeSSE(res, onEvent as (event: unknown) => void);
}

export async function confirmAnalyzeBatch(
  sessionId: string,
  batchId: string,
  decision: "confirm" | "cancel",
  password?: string
): Promise<void> {
  await fetch(`${BACKEND_URL}/api/assistant/analyze/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, batch_id: batchId, decision, password }),
  });
}

async function consumeSSE(res: Response, onEvent: (event: unknown) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const dataLine = line.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        onEvent(JSON.parse(dataLine.slice(5).trim()));
      } catch {
        // ignore malformed chunk
      }
    }
  }
}

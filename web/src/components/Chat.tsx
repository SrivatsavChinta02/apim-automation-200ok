"use client";

import { useRef, useState } from "react";
import {
  parseQuery,
  runStep,
  streamAnalyze,
  confirmAnalyzeBatch,
  type ChatMessage,
  type Plan,
} from "@/lib/api";

type Bubble = {
  id: string;
  role: "user" | "assistant" | "system" | "error";
  text: string;
};

type PendingPlan = { plan: Plan };

type PendingConfirmation = {
  sessionId: string;
  batchId: string;
  tools: Array<{ name: string; preview: string; requires_password: boolean }>;
  requiresPassword: boolean;
};

const uid = () => Math.random().toString(36).slice(2);

export default function Chat() {
  const [bubbles, setBubbles] = useState<Bubble[]>([
    {
      id: uid(),
      role: "system",
      text: "Ask me to onboard an API, promote between environments, check versions, or anything else you'd do in APIM.",
    },
  ]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [password, setPassword] = useState("");
  const sessionId = useRef(uid());
  const bottomRef = useRef<HTMLDivElement>(null);

  function addBubble(role: Bubble["role"], text: string) {
    setBubbles((b) => [...b, { id: uid(), role, text }]);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  function updateLastBubble(text: string) {
    setBubbles((b) => {
      const copy = [...b];
      copy[copy.length - 1] = { ...copy[copy.length - 1], text };
      return copy;
    });
  }

  async function executeSteps(plan: Plan) {
    addBubble("assistant", `Running: ${plan.name}...`);
    for (const step of plan.steps) {
      try {
        await runStep(step, (event) => {
          const summary = summarizeStepEvent(event);
          if (summary) updateLastBubble(summary);
        });
      } catch (e) {
        addBubble("error", `${step.label} failed: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    addBubble("assistant", `Done — ${plan.name} complete.`);
  }

  async function handleAnalyze(query: string) {
    addBubble("assistant", "Thinking...");
    try {
      await streamAnalyze(query, history, sessionId.current, (event) => {
        switch (event.event) {
          case "tool_call_start":
            updateLastBubble(`Running ${event.data.tool}...`);
            break;
          case "tool_call_done":
            updateLastBubble(`${event.data.tool}: ${event.data.summary}`);
            break;
          case "tool_confirmation_required":
            setPendingConfirmation({
              sessionId: sessionId.current,
              batchId: event.data.batch_id,
              tools: event.data.tools,
              requiresPassword: event.data.requires_password,
            });
            break;
          case "final_answer":
            updateLastBubble(event.data.text);
            setHistory((h) => [...h, { role: "assistant", content: event.data.text }]);
            break;
          case "error":
            updateLastBubble(`Error: ${event.data.message}`);
            break;
        }
      });
    } catch (e) {
      addBubble("error", e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSend() {
    const query = input.trim();
    if (!query || busy) return;
    setInput("");
    addBubble("user", query);
    const nextHistory: ChatMessage[] = [...history, { role: "user", content: query }];
    setHistory(nextHistory);
    setBusy(true);
    try {
      const res = await parseQuery(query, history);
      switch (res.status) {
        case "off_topic":
          addBubble("assistant", "That's outside what I can help with here.");
          break;
        case "no_match":
          addBubble("assistant", "I couldn't find a matching action for that. Try rephrasing.");
          break;
        case "needs_params":
          addBubble("assistant", `I need a bit more info: ${res.missing.join(", ")}. Add those details and resend.`);
          break;
        case "invalid_params":
          addBubble("assistant", `These values don't look right: ${res.invalid.join(", ")}. Can you correct them?`);
          break;
        case "error":
          addBubble("error", res.message);
          break;
        case "analyze":
          await handleAnalyze(res.query);
          break;
        case "ok":
          addBubble("assistant", res.plan.summary);
          setHistory((h) => [...h, { role: "assistant", content: res.plan.summary }]);
          if (res.plan.gate_required) {
            setPendingPlan({ plan: res.plan });
          } else {
            await executeSteps(res.plan);
          }
          break;
      }
    } catch (e) {
      addBubble("error", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handlePlanDecision(decision: "confirm" | "cancel") {
    const plan = pendingPlan?.plan;
    setPendingPlan(null);
    if (!plan) return;
    if (decision === "cancel") {
      addBubble("assistant", "Cancelled.");
      return;
    }
    setBusy(true);
    await executeSteps(plan);
    setBusy(false);
  }

  async function handleConfirmationDecision(decision: "confirm" | "cancel") {
    const pending = pendingConfirmation;
    setPendingConfirmation(null);
    if (!pending) return;
    await confirmAnalyzeBatch(pending.sessionId, pending.batchId, decision, password || undefined);
    setPassword("");
  }

  return (
    <div className="flex flex-1 flex-col w-full max-w-2xl mx-auto">
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-3">
        {bubbles.map((b) => (
          <div
            key={b.id}
            className={`max-w-[85%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap ${
              b.role === "user"
                ? "ml-auto bg-blue-600 text-white"
                : b.role === "error"
                ? "bg-red-100 text-red-800 border border-red-300"
                : b.role === "system"
                ? "bg-zinc-100 text-zinc-600 text-xs"
                : "bg-zinc-100 text-zinc-900"
            }`}
          >
            {b.text}
          </div>
        ))}

        {pendingPlan && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="mb-2 font-medium">Confirm: {pendingPlan.plan.name}</p>
            <ul className="mb-3 list-disc pl-5 text-zinc-700">
              {pendingPlan.plan.steps.map((s, i) => (
                <li key={i}>{s.label}</li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                onClick={() => handlePlanDecision("confirm")}
                className="rounded bg-amber-600 px-3 py-1 text-white hover:bg-amber-700"
              >
                Confirm
              </button>
              <button
                onClick={() => handlePlanDecision("cancel")}
                className="rounded border border-zinc-300 px-3 py-1 hover:bg-zinc-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {pendingConfirmation && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
            <p className="mb-2 font-medium">Confirm action</p>
            <ul className="mb-3 list-disc pl-5 text-zinc-700">
              {pendingConfirmation.tools.map((t, i) => (
                <li key={i}>{t.preview || t.name}</li>
              ))}
            </ul>
            {pendingConfirmation.requiresPassword && (
              <input
                type="password"
                placeholder="Admin password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mb-3 w-full rounded border border-zinc-300 px-2 py-1"
              />
            )}
            <div className="flex gap-2">
              <button
                onClick={() => handleConfirmationDecision("confirm")}
                className="rounded bg-amber-600 px-3 py-1 text-white hover:bg-amber-700"
              >
                Confirm
              </button>
              <button
                onClick={() => handleConfirmationDecision("cancel")}
                className="rounded border border-zinc-300 px-3 py-1 hover:bg-zinc-100"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-zinc-200 p-4">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            disabled={busy}
            placeholder="e.g. Promote checkout-api from dev to sandbox"
            className="flex-1 rounded border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function summarizeStepEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const text = e.message || e.status || e.summary || e.step;
  return typeof text === "string" ? text : JSON.stringify(e).slice(0, 200);
}

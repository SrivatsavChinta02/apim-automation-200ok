"use client";

import { useRef, useState } from "react";
import {
  parseQuery,
  runStep,
  streamAnalyze,
  confirmAnalyzeBatch,
  type ChatMessage,
  type Plan,
  type PlanStep,
  type ApiDiff,
  type PromoteSummary,
  type OnboardSummary,
} from "@/lib/api";
import { ENVS, RichText, cleanCopy, deriveEnvs } from "@/lib/format";
import PipelineLoader from "@/components/PipelineLoader";
import SuggestionChips from "@/components/SuggestionChips";
import {
  CompareCard,
  PromoteCard,
  OnboardCard,
  ErrorCard,
} from "@/components/Cards";

type CardData =
  | { type: "compare"; diff: ApiDiff; src: string; dest: string }
  | { type: "promote"; summary: PromoteSummary }
  | { type: "onboard"; summary: OnboardSummary; env: string; title: string }
  | { type: "error"; message: string };

type Msg =
  | { id: string; role: "user" | "assistant" | "system"; text: string }
  | { id: string; role: "card"; card: CardData };

type Loader = { active: string[]; label: string };

type PendingPlan = { plan: Plan; needsPassword: boolean };

type PendingConfirmation = {
  sessionId: string;
  batchId: string;
  tools: Array<{ name: string; preview: string; requires_password: boolean }>;
  requiresPassword: boolean;
};

type StepEvent = Record<string, unknown>;
type Capture =
  | { kind: "done"; summary?: Record<string, unknown>; message?: string }
  | { kind: "error"; message: string }
  | { kind: "needs_input"; message: string }
  | { kind: "diff"; data: ApiDiff };

const uid = () => Math.random().toString(36).slice(2);
const isEnv = (v: unknown): v is string =>
  typeof v === "string" && (ENVS as readonly string[]).includes(v);

/** Which environment nodes should light up for this step, derived from the
 * step's real params/payload — never a hardcoded per-intent guess. */
function stepEnvs(step: PlanStep): string[] {
  const p = (step.params ?? step.payload ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => p[k]).filter(isEnv);
  switch (step.action) {
    case "READ_diff":
    case "POST_promote":
    case "POST_bulk_promote":
      return pick("src", "dest");
    case "POST_create_api":
    case "POST_onboard":
      return pick("env");
    default:
      return [];
  }
}

export default function Chat() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: uid(),
      role: "assistant",
      text: "Ask me to onboard an API, promote between environments, check revisions, or anything else you would do in APIM.",
    },
  ]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loader, setLoader] = useState<Loader | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [password, setPassword] = useState("");
  const sessionId = useRef(uid());
  const bottomRef = useRef<HTMLDivElement>(null);

  function scrollSoon() {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }

  function addMsg(msg: Msg) {
    setMessages((m) => [...m, msg]);
    scrollSoon();
  }

  function addText(role: "assistant" | "system", text: string) {
    addMsg({ id: uid(), role, text });
  }

  function addCard(card: CardData) {
    addMsg({ id: uid(), role: "card", card });
  }

  function setLoaderLabel(label: string) {
    setLoader((l) => (l ? { ...l, label: cleanCopy(label) } : l));
  }

  function renderStepResult(step: PlanStep, envs: string[], capture: Capture | null) {
    if (capture?.kind === "error") {
      addCard({ type: "error", message: capture.message });
      return;
    }
    switch (step.action) {
      case "READ_diff": {
        if (capture?.kind === "diff") {
          const d = capture.data;
          if (d.error) addCard({ type: "error", message: d.error });
          else addCard({ type: "compare", diff: d, src: envs[0] || "dev", dest: envs[1] || "prod" });
        } else {
          addText("assistant", "No comparison data was returned.");
        }
        break;
      }
      case "POST_promote":
      case "POST_bulk_promote": {
        if (capture?.kind === "done") {
          const summary = { src: envs[0], dest: envs[1], ...(capture.summary || {}) } as PromoteSummary;
          addCard({ type: "promote", summary });
        } else if (capture?.kind === "needs_input") {
          addText(
            "assistant",
            `${capture.message} This step needs manual input, which the console does not resolve yet. Use the extension UI to finish it.`
          );
        } else {
          addText("assistant", "The promotion finished without a completion signal.");
        }
        break;
      }
      case "POST_create_api":
      case "POST_onboard": {
        if (capture?.kind === "done") {
          const env = envs[0] || "dev";
          const title =
            step.action === "POST_create_api"
              ? `Created the new API in ${env}.`
              : `Onboarding complete in ${env}.`;
          addCard({ type: "onboard", summary: (capture.summary || {}) as OnboardSummary, env, title });
        } else {
          addText("assistant", "The operation finished without a completion signal.");
        }
        break;
      }
      default: {
        if (capture?.kind === "done" && capture.message) addText("assistant", capture.message);
        break;
      }
    }
  }

  async function runPlan(plan: Plan) {
    for (const step of plan.steps) {
      const envs = stepEnvs(step);
      setLoader({ active: envs, label: cleanCopy(step.label) });
      let capture: Capture | null = null;
      try {
        await runStep(step, (event) => {
          if (!event || typeof event !== "object") return;
          const e = event as StepEvent;
          const status = typeof e.status === "string" ? e.status : undefined;
          const message = typeof e.message === "string" ? e.message : undefined;
          if (status === "done") {
            capture = { kind: "done", summary: e.summary as Record<string, unknown>, message };
          } else if (status === "error" || status === "step_error") {
            capture = { kind: "error", message: message || "Step failed." };
          } else if (status === "needs_input") {
            capture = { kind: "needs_input", message: message || "Additional input is required." };
          } else if (status && message) {
            setLoaderLabel(message);
          } else if (typeof e.error === "string") {
            capture = { kind: "error", message: e.error };
          } else if (step.action === "READ_diff") {
            capture = { kind: "diff", data: e as unknown as ApiDiff };
          }
        });
      } catch (err) {
        setLoader(null);
        addCard({ type: "error", message: err instanceof Error ? err.message : String(err) });
        return;
      }
      setLoader(null);
      renderStepResult(step, envs, capture);
      if ((capture as Capture | null)?.kind === "error") return;
    }
  }

  async function handleAnalyze(query: string) {
    setLoader({ active: deriveEnvs(query), label: "Analyzing your request" });
    try {
      await streamAnalyze(query, history, sessionId.current, (event) => {
        switch (event.event) {
          case "tool_call_start":
            setLoaderLabel(`Running ${event.data.tool}`);
            break;
          case "tool_call_done":
            setLoaderLabel(event.data.summary || event.data.tool);
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
            setLoader(null);
            addText("assistant", event.data.text);
            setHistory((h) => [...h, { role: "assistant", content: event.data.text }]);
            break;
          case "error":
            setLoader(null);
            addCard({ type: "error", message: event.data.message });
            break;
        }
      });
    } catch (e) {
      addCard({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoader(null);
    }
  }

  async function handleSend(raw: string) {
    const query = raw.trim();
    if (!query || busy) return;
    setInput("");
    addMsg({ id: uid(), role: "user", text: query });
    setHistory((h) => [...h, { role: "user", content: query }]);
    setBusy(true);
    try {
      const res = await parseQuery(query, history);
      switch (res.status) {
        case "off_topic":
          addText("assistant", "That is outside what I can help with here.");
          break;
        case "no_match":
          addText("assistant", "I could not find a matching action for that. Try rephrasing.");
          break;
        case "needs_params":
          addText("assistant", `I need a bit more detail: ${res.missing.join(", ")}. Add those and resend.`);
          break;
        case "invalid_params":
          addText("assistant", `These values do not look right: ${res.invalid.join(", ")}. Please correct them.`);
          break;
        case "error":
          addCard({ type: "error", message: res.message });
          break;
        case "analyze":
          await handleAnalyze(res.query);
          break;
        case "ok":
          if (res.plan.gate_required) {
            const needsPassword = res.plan.steps.some(
              (s) => s.action === "POST_promote" && isEnv(s.payload?.dest) && s.payload?.dest !== "sandbox"
            );
            addText("assistant", res.plan.summary);
            setPendingPlan({ plan: res.plan, needsPassword });
          } else {
            await runPlan(res.plan);
          }
          break;
      }
    } catch (e) {
      addCard({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function handlePlanDecision(decision: "confirm" | "cancel") {
    const pending = pendingPlan;
    setPendingPlan(null);
    if (!pending) return;
    if (decision === "cancel") {
      addText("assistant", "Cancelled.");
      setPassword("");
      return;
    }
    const plan = pending.plan;
    if (pending.needsPassword && password) {
      plan.steps.forEach((s) => {
        if (s.action === "POST_promote" && s.payload) s.payload.admin_password = password;
      });
    }
    setBusy(true);
    await runPlan(plan);
    setPassword("");
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
    <>
      <main className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg-in flex justify-end">
              <div className="max-w-[80%] bg-[var(--primary)] text-white text-[14px] leading-relaxed rounded-2xl rounded-br-md px-4 py-2.5 elev-1">
                {m.text}
              </div>
            </div>
          ) : m.role === "card" ? (
            <div key={m.id} className="msg-in flex justify-start">
              <div className="max-w-[88%] bg-white text-[var(--ink-900)] text-[14px] leading-relaxed rounded-2xl rounded-bl-md px-4 py-3 border border-[var(--line)] elev-1 w-full sm:w-auto">
                <CardView card={m.card} />
              </div>
            </div>
          ) : (
            <div key={m.id} className="msg-in flex justify-start">
              <div className="max-w-[88%] bg-white text-[var(--ink-900)] text-[14px] leading-relaxed rounded-2xl rounded-bl-md px-4 py-3 border border-[var(--line)] elev-1">
                <RichText text={m.text} />
              </div>
            </div>
          )
        )}

        {loader && <PipelineLoader activeEnvs={loader.active} label={loader.label} />}

        {pendingPlan && (
          <div className="msg-in rounded-2xl border border-[var(--warning)]/40 bg-[var(--warning-container)] p-3.5 text-[13px]">
            <p className="mb-2 font-semibold text-[var(--ink-900)]">Confirm: {pendingPlan.plan.name}</p>
            <ul className="mb-3 space-y-1 text-[var(--ink-600)]">
              {pendingPlan.plan.steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-1.5 w-1 h-1 rounded-full bg-[var(--ink-400)] shrink-0" />
                  {cleanCopy(s.label)}
                </li>
              ))}
            </ul>
            {pendingPlan.needsPassword && (
              <input
                type="password"
                placeholder="Admin password (required for this environment)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mb-3 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[13px] outline-none focus:border-[var(--primary)]"
              />
            )}
            <div className="flex gap-2">
              <button
                onClick={() => handlePlanDecision("confirm")}
                disabled={pendingPlan.needsPassword && !password}
                className="rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-white font-medium hover:bg-[var(--primary-dark)] disabled:opacity-40"
              >
                Confirm
              </button>
              <button
                onClick={() => handlePlanDecision("cancel")}
                className="rounded-lg border border-[var(--line)] bg-white px-3.5 py-1.5 hover:bg-[var(--surface-dim)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {pendingConfirmation && (
          <div className="msg-in rounded-2xl border border-[var(--warning)]/40 bg-[var(--warning-container)] p-3.5 text-[13px]">
            <p className="mb-2 font-semibold text-[var(--ink-900)]">Confirm action</p>
            <ul className="mb-3 space-y-1 text-[var(--ink-600)]">
              {pendingConfirmation.tools.map((t, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-1.5 w-1 h-1 rounded-full bg-[var(--ink-400)] shrink-0" />
                  {cleanCopy(t.preview || t.name)}
                </li>
              ))}
            </ul>
            {pendingConfirmation.requiresPassword && (
              <input
                type="password"
                placeholder="Admin password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mb-3 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[13px] outline-none focus:border-[var(--primary)]"
              />
            )}
            <div className="flex gap-2">
              <button
                onClick={() => handleConfirmationDecision("confirm")}
                disabled={pendingConfirmation.requiresPassword && !password}
                className="rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-white font-medium hover:bg-[var(--primary-dark)] disabled:opacity-40"
              >
                Confirm
              </button>
              <button
                onClick={() => handleConfirmationDecision("cancel")}
                className="rounded-lg border border-[var(--line)] bg-white px-3.5 py-1.5 hover:bg-[var(--surface-dim)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </main>

      <SuggestionChips onSelect={handleSend} disabled={busy} />

      <footer className="shrink-0 bg-white border-t border-[var(--line)] px-4 py-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleSend(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            autoComplete="off"
            placeholder="e.g. Promote checkout-api from dev to sandbox"
            className="composer-input flex-1 text-[14px] bg-[var(--surface-dim)] border border-transparent focus:border-[var(--primary)] focus:bg-white rounded-2xl px-4 py-3 outline-none transition-all placeholder:text-[var(--ink-400)] disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy}
            className="ripple shrink-0 w-11 h-11 rounded-full bg-[var(--primary)] hover:bg-[var(--primary-dark)] active:scale-95 flex items-center justify-center transition-all elev-2 disabled:opacity-40 disabled:pointer-events-none"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke="white"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>
      </footer>
    </>
  );
}

function CardView({ card }: { card: CardData }) {
  switch (card.type) {
    case "compare":
      return <CompareCard diff={card.diff} src={card.src} dest={card.dest} />;
    case "promote":
      return <PromoteCard summary={card.summary} />;
    case "onboard":
      return <OnboardCard summary={card.summary} env={card.env} title={card.title} />;
    case "error":
      return <ErrorCard message={card.message} />;
  }
}

"use client";

import { useEffect, useState } from "react";
import { fetchHealth } from "@/lib/api";
import { ENVS } from "@/lib/format";

/**
 * Top bar with the product identity and an environment status row.
 * The dots are data driven: configured environments (reported by
 * /api/health) show a success dot, unconfigured ones show a muted dot.
 * This is NOT live connectivity health — see README note on adding
 * GET /api/health/environments for that.
 */
export default function AppHeader() {
  const [configured, setConfigured] = useState<string[] | null>(null);

  useEffect(() => {
    let active = true;
    fetchHealth().then((envs) => {
      if (active) setConfigured(envs);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <header className="shrink-0 bg-white border-b border-[var(--line)] px-5 py-3.5 z-10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[var(--primary)] flex items-center justify-center elev-1">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 12H10M14 12H20M8 6L8 18M16 6L16 18"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div>
            <h1 className="font-display font-bold text-[15px] leading-tight text-[var(--ink-900)]">
              APIM Console
            </h1>
            <p className="text-[11px] text-[var(--ink-400)] leading-tight">
              Onboard, promote, and audit your APIs
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 mt-3 overflow-x-auto no-scrollbar">
        <span className="text-[10px] uppercase tracking-wider text-[var(--ink-400)] font-semibold mr-0.5 shrink-0">
          Environments
        </span>
        {ENVS.map((env) => {
          // Until health loads, treat every env as neutral to avoid a flash.
          const isConfigured = configured === null ? false : configured.includes(env);
          return (
            <div key={env} className="flex items-center gap-1 shrink-0">
              <span
                className={`env-pill-dot ${
                  isConfigured ? "bg-[var(--success)]" : "bg-[var(--ink-400)]"
                }`}
                title={isConfigured ? "configured" : "not configured"}
              />
              <span className="text-[11px] font-mono text-[var(--ink-600)] px-1.5 py-0.5 rounded-md bg-[var(--surface-dim)]">
                {env}
              </span>
            </div>
          );
        })}
      </div>
    </header>
  );
}

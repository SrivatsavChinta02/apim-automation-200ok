import { ENVS } from "@/lib/format";

/**
 * The signature loader: one node per environment, lit up according to
 * what the operation actually touches. `activeEnvs` comes from the real
 * plan step params (src/dest/env) or, for analyze queries, the envs
 * mentioned in the request text. Never hardcoded per intent.
 */
export default function PipelineLoader({
  activeEnvs,
  label,
}: {
  activeEnvs: string[];
  label: string;
}) {
  return (
    <div className="msg-in flex justify-start">
      <div className="max-w-[88%] bg-white rounded-2xl rounded-bl-md px-4 py-4 border border-[var(--line)] elev-1 w-full sm:w-80">
        <p className="text-[12.5px] text-[var(--ink-600)] mb-3.5">{label}</p>
        <div className="relative flex items-center justify-between px-1">
          <div
            className="absolute left-4 right-4 top-1/2 h-px bg-[var(--line)]"
            style={{ transform: "translateY(-50%)" }}
          />
          {ENVS.map((env) => {
            const active = activeEnvs.includes(env);
            return (
              <div
                key={env}
                className="flex flex-col items-center gap-1.5 relative z-10"
              >
                <div
                  className={`node-dot w-3 h-3 rounded-full bg-[var(--ink-400)] ${
                    active ? "node-active pulse-dot" : ""
                  }`}
                />
                <span className="text-[9.5px] font-mono uppercase tracking-wide text-[var(--ink-400)]">
                  {env}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

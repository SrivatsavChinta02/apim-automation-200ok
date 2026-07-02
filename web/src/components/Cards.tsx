import type { ApiDiff, PromoteSummary, OnboardSummary } from "@/lib/api";
import { cleanCopy } from "@/lib/format";

const ENV_CHIP_COLORS: Record<string, string> = {
  dev: "bg-[var(--success-container)] text-[var(--success)]",
  sandbox: "bg-[var(--primary-container)] text-[var(--primary-dark)]",
  prod: "bg-[var(--warning-container)] text-[var(--warning)]",
  dr: "bg-[var(--surface-dim)] text-[var(--ink-600)]",
};

export function EnvChip({ name }: { name: string }) {
  const cls = ENV_CHIP_COLORS[name] || "bg-[var(--surface-dim)] text-[var(--ink-600)]";
  return (
    <span className={`font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded ${cls}`}>
      {name}
    </span>
  );
}

function ApiName({ name }: { name: string }) {
  return (
    <strong className="font-mono font-semibold text-[13px] bg-[var(--surface-dim)] px-1.5 py-0.5 rounded">
      {name}
    </strong>
  );
}

function ArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ink-400)" strokeWidth="2">
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Single-API comparison across two environments (from /api/diff/api). */
export function CompareCard({
  diff,
  src,
  dest,
}: {
  diff: ApiDiff;
  src: string;
  dest: string;
}) {
  const apiName = diff.api_id || diff.src?.displayName || diff.dest?.displayName || "the api";

  // Instance-level diff (no single api_id / operations) — render a summary.
  if (!diff.operations && diff.summary) {
    const s = diff.summary;
    return (
      <div>
        <p className="mb-3">
          Instance comparison between <EnvChip name={src} /> and <EnvChip name={dest} />.
        </p>
        <div className="rounded-xl border border-[var(--line)] p-3 space-y-1.5 text-[12.5px]">
          <Row label="Identical" value={String(s.identical ?? 0)} />
          <Row label="Different" value={String(s.different ?? 0)} />
          <Row label={`Only in ${src}`} value={String(s.only_src ?? 0)} />
          <Row label={`Only in ${dest}`} value={String(s.only_dest ?? 0)} />
          {typeof s.renamed === "number" && s.renamed > 0 && (
            <Row label="Renamed" value={String(s.renamed)} />
          )}
        </div>
      </div>
    );
  }

  const opsAdded = diff.ops_added ?? 0;
  const opsChanged = diff.ops_changed ?? 0;
  const policyDiffers = diff.policy?.differs ?? false;
  const hasDiff = opsAdded > 0 || opsChanged > 0 || policyDiffers;

  const srcRev = diff.src?.revision ?? diff.src_revision ?? "missing";
  const destRev = diff.dest?.revision ?? diff.dest_revision ?? "missing";

  const summaryText = hasDiff
    ? `Differences found. ${opsAdded} operations added, ${opsChanged} changed, policy ${
        policyDiffers ? "differs" : "matches"
      }.`
    : "No differences found. Both environments match.";

  return (
    <div>
      <p className="mb-3">
        Here is the comparison for <ApiName name={apiName} /> across environments.
      </p>
      <div className="rounded-xl border border-[var(--line)] overflow-hidden">
        <div className="grid grid-cols-2 divide-x divide-[var(--line)]">
          <DiffColumn env={src} rev={String(srcRev)} path={diff.src?.path} present={!!diff.src} />
          <DiffColumn env={dest} rev={String(destRev)} path={diff.dest?.path} present={!!diff.dest} />
        </div>
        <div
          className={`px-3 py-2 text-[11.5px] font-medium ${
            hasDiff
              ? "bg-[var(--warning-container)] text-[var(--warning)]"
              : "bg-[var(--success-container)] text-[var(--success)]"
          }`}
        >
          {summaryText}
        </div>
      </div>
    </div>
  );
}

function DiffColumn({
  env,
  rev,
  path,
  present,
}: {
  env: string;
  rev: string;
  path?: string;
  present: boolean;
}) {
  return (
    <div className="p-3">
      <div className="flex items-center gap-1.5 mb-2">
        <EnvChip name={env} />
      </div>
      {present ? (
        <dl className="space-y-1.5 text-[12.5px]">
          <Row label="Revision" value={`v${rev}`} mono />
          {path && <Row label="Path" value={path} mono />}
        </dl>
      ) : (
        <p className="text-[12px] text-[var(--ink-400)]">Not present in this environment.</p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--ink-400)] shrink-0">{label}</dt>
      <dd className={`text-right break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

/** Successful promotion result (from a promote SSE `status:"done"` summary). */
export function PromoteCard({ summary }: { summary: PromoteSummary }) {
  const apiName = summary.api_name || summary.api_id || "the api";
  const fromEnv = summary.src || "dev";
  const toEnv = summary.dest || "sandbox";
  return (
    <div>
      <p className="mb-3">
        Promotion result for <ApiName name={apiName} />
      </p>
      <div className="flex items-center justify-center gap-3 rounded-xl border border-[var(--line)] p-4 mb-3">
        <EnvChip name={fromEnv} />
        <ArrowIcon />
        <EnvChip name={toEnv} />
      </div>
      <div className="flex items-center gap-2 bg-[var(--success-container)] text-[var(--success)] text-[12.5px] font-medium px-3 py-2 rounded-lg">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Promoted successfully.
        {summary.revision != null ? ` Revision ${summary.revision} is live in ${toEnv}.` : ` Live in ${toEnv}.`}
      </div>
    </div>
  );
}

/** Successful create/onboard result (from a create or onboard SSE summary). */
export function OnboardCard({
  summary,
  env,
  title,
}: {
  summary: OnboardSummary;
  env: string;
  title: string;
}) {
  const items: { label: string; value?: string }[] = [];
  if (summary.product_name || summary.product_id)
    items.push({ label: "Product", value: summary.product_name || summary.product_id });
  if (summary.subscription_name || summary.subscription_id)
    items.push({ label: "Subscription", value: summary.subscription_name || summary.subscription_id });
  if (summary.backend_id) items.push({ label: "Backend", value: summary.backend_id });
  if (typeof summary.operations === "number")
    items.push({ label: "Operations", value: String(summary.operations) });
  if (typeof summary.operations_updated === "number")
    items.push({ label: "Operations updated", value: String(summary.operations_updated) });
  if (summary.revision != null) items.push({ label: "Revision", value: String(summary.revision) });

  const primaryKey =
    summary.keys && typeof summary.keys === "object"
      ? (summary.keys as Record<string, unknown>).primaryKey
      : undefined;

  return (
    <div>
      <p className="mb-3">{cleanCopy(title)}</p>
      <ul className="space-y-2 text-[13px]">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] shrink-0" />
            <span className="text-[var(--ink-600)]">{it.label}:</span>
            <span className="font-mono text-[12.5px] break-all">{it.value}</span>
          </li>
        ))}
      </ul>
      {typeof primaryKey === "string" && primaryKey && (
        <p className="mt-3 text-[12px] text-[var(--ink-400)]">
          Subscription key issued (starts {primaryKey.slice(0, 6)}...). Copy it from the summary; it is shown once.
        </p>
      )}
      <p className="mt-3 text-[12.5px] text-[var(--ink-400)]">
        Live in <EnvChip name={env} />.
      </p>
    </div>
  );
}

/** Revision count. Not currently wired (revision queries route through the
 * analyze loop and return prose) but kept for a future structured endpoint. */
export function RevisionsCard({
  apiName,
  env,
  count,
}: {
  apiName: string;
  env: string;
  count: number;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-11 h-11 rounded-xl bg-[var(--primary-container)] flex items-center justify-center shrink-0">
        <span className="font-display font-extrabold text-[16px] text-[var(--primary-dark)]">{count}</span>
      </div>
      <div>
        <p className="text-[14px]">
          <ApiName name={apiName} /> in <EnvChip name={env} />
        </p>
        <p className="text-[12px] text-[var(--ink-400)] mt-0.5">
          {count} revisions total, latest is current
        </p>
      </div>
    </div>
  );
}

export function ErrorCard({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="w-6 h-6 rounded-full bg-[var(--error-container)] flex items-center justify-center shrink-0 mt-0.5">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="2.5">
          <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <div>
        <p className="text-[13.5px] font-semibold text-[var(--error)]">Request failed</p>
        <p className="text-[13px] text-[var(--ink-600)] mt-0.5">{cleanCopy(message)}</p>
      </div>
    </div>
  );
}

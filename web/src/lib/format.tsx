import { Fragment, type ReactNode } from "react";

/** The four APIM environments, in display order. */
export const ENVS = ["dev", "sandbox", "prod", "dr"] as const;
export type Env = (typeof ENVS)[number];

/**
 * Strip characters we never want to render in the UI:
 * em dashes and en dashes become a plain hyphen, non-breaking
 * spaces become regular spaces. Backend SSE messages sometimes
 * contain em dashes (e.g. "Promotion complete — revision 3").
 */
export function cleanCopy(s: string): string {
  return (s || "").replace(/[—–]/g, "-").replace(/ /g, " ");
}

/** Which environments does this free text mention? Used to light up
 * pipeline-loader nodes for analyze queries that have no structured plan. */
export function deriveEnvs(text: string): Env[] {
  const lower = (text || "").toLowerCase();
  return ENVS.filter((e) => new RegExp(`\\b${e}\\b`).test(lower));
}

function renderBoldSegments(line: string, keyPrefix: string): ReactNode[] {
  // Split on **bold** spans, converting them to real <strong> elements
  // so raw ** never reaches the DOM.
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>;
  });
}

/**
 * Renders text with markdown bold converted to real bold styling and
 * newlines preserved. Em dashes are cleaned out. This is the single
 * place backend-authored text is turned into UI, so the "no raw **"
 * and "no em dash" rules hold everywhere it is used.
 */
export function RichText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const lines = cleanCopy(text).split("\n");
  return (
    <span className={className}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {renderBoldSegments(line, String(i))}
        </Fragment>
      ))}
    </span>
  );
}

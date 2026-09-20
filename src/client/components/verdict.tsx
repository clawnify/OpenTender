// How a verdict looks, in one place.
//
// The board and the tender screen both render the call, and they must never
// disagree about what "blocked" looks like or how a deadline is worded: a
// verdict that changes colour between two screens is one people stop reading.

import { Badge, type Tone } from "./ui";
import type { FamilyRoll } from "../api";

const VERDICTS: Record<string, { label: string; tone: Tone }> = {
  go: { label: "Go", tone: "success" },
  no_go: { label: "No-go", tone: "danger" },
  blocked: { label: "Unresolved", tone: "warning" },
  unknown: { label: "Not started", tone: "neutral" },
};

export function verdictTone(verdict: string): Tone {
  return VERDICTS[verdict]?.tone ?? "neutral";
}

export function VerdictBadge({ verdict }: { verdict: string }) {
  const shape = VERDICTS[verdict] ?? VERDICTS.unknown;
  return <Badge tone={shape.tone}>{shape.label}</Badge>;
}

/**
 * A countdown that says what it means.
 *
 * "in 4 days" and "4 days ago" are a single sign apart and mean opposite
 * things to someone deciding whether to bid, so the past tense is spelled out
 * rather than left to a minus sign nobody reads at 4pm.
 */
export function deadlineWords(days: number | null, noun = "deadline"): string {
  if (days === null) return `no ${noun} recorded`;
  if (days < 0) return `${noun} passed ${Math.abs(days)} ${plural(Math.abs(days), "day")} ago`;
  if (days === 0) return `${noun} is today`;
  return `${days} ${plural(days, "day")} to ${noun}`;
}

export function deadlineTone(days: number | null): Tone {
  if (days === null) return "neutral";
  if (days < 0) return "danger";
  if (days <= 3) return "warning";
  return "neutral";
}

function plural(n: number, word: string) {
  return n === 1 ? word : `${word}s`;
}

const FAMILY_LABELS: Record<string, string> = {
  economic: "Economic and financial standing",
  technical: "Technical capability",
  professional: "Professional standing",
  legal: "Exclusion grounds",
  social_value: "Social value",
  other: "Other",
};

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family;
}

/**
 * Per-family progress, the fraction first.
 *
 * `met/total` counts only the requirements this tender actually imposes, so a
 * row reading 0/1 is one real unmet bar rather than a scoring artefact. The bar
 * is the secondary read; the number is the one people quote to each other.
 */
export function FamilyBar({ roll }: { roll: FamilyRoll }) {
  const fills: Record<string, string> = {
    pass: "bg-success",
    blocked: "bg-danger",
    unknown: "bg-warning",
    not_applicable: "bg-faint",
  };
  const pct = roll.total === 0 ? 0 : Math.round((roll.met / roll.total) * 100);

  return (
    <div className="flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate text-sm">{familyLabel(roll.family)}</span>
      <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
        <div className={`h-full rounded-full ${fills[roll.state] ?? "bg-faint"}`} style={{ width: `${pct}%` }} />
      </div>
      <span
        className={`data w-10 shrink-0 text-right text-sm font-medium ${
          roll.state === "pass" ? "text-success" : roll.state === "blocked" ? "text-danger" : "text-muted"
        }`}
      >
        {roll.total === 0 ? "n/a" : `${roll.met}/${roll.total}`}
      </span>
    </div>
  );
}

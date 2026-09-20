// The bid/no-bid call, derived rather than stored.
//
// Nothing writes a verdict into the database. It is recomputed from the
// findings on every read, which costs almost nothing and buys the one property
// that matters: the verdict can never disagree with the evidence shown
// underneath it. A stored verdict goes stale the moment someone records a
// certificate or an agent re-reads a page, and a stale no-go is worse than no
// verdict at all, because people act on it.
//
// The rules are deliberately blunt. A qualification decision that needs a
// paragraph to explain itself will not be trusted at 4pm on a deadline.

export type Verdict = "go" | "no_go" | "blocked" | "unknown";

/** met | not_met | unknown | not_stated | rejected */
export type FindingStatus = string;

export interface RequirementRow {
  key: string;
  label: string;
  family: string;
  /** mandatory | scored | optional */
  obligation: string;
  weighting?: string;
}

export interface FindingRow {
  requirement_key: string;
  status: FindingStatus;
  stated?: string;
  our_evidence?: string;
  rejected_reason?: string;
  page_no?: number | null;
}

export interface Blocker {
  key: string;
  label: string;
  stated: string;
  our_evidence: string;
}

export interface OpenQuestion {
  key: string;
  label: string;
  reason: string;
}

export interface FamilyRoll {
  family: string;
  /** Mandatory requirements that came back `met`. */
  met: number;
  /** Mandatory requirements this tender actually imposes (`not_stated` does not count). */
  total: number;
  state: "pass" | "blocked" | "unknown" | "not_applicable";
}

export interface VerdictReport {
  verdict: Verdict;
  reason: string;
  blockers: Blocker[];
  open_questions: OpenQuestion[];
  families: FamilyRoll[];
  /** Scored criteria are not part of the verdict; they are how close the bid is. */
  scored: { answered: number; total: number };
}

const FAMILY_ORDER = ["economic", "technical", "professional", "legal", "social_value", "other"];

/**
 * Why `not_stated` never blocks.
 *
 * A pack that says nothing about insurance has not set an insurance bar we
 * might fail; it has no insurance bar. Treating silence as a failure would
 * make every short tender read as no-go, and the first thing a user would do
 * is stop believing the verdict. Silence is the absence of a hurdle.
 */
function imposed(status: FindingStatus): boolean {
  return status !== "not_stated";
}

export function buildVerdict(
  requirements: RequirementRow[],
  findings: FindingRow[],
): VerdictReport {
  const byKey = new Map(findings.map((f) => [f.requirement_key, f]));
  const mandatory = requirements.filter((r) => r.obligation === "mandatory");
  const scored = requirements.filter((r) => r.obligation === "scored");

  const blockers: Blocker[] = [];
  const open_questions: OpenQuestion[] = [];

  for (const req of mandatory) {
    const finding = byKey.get(req.key);

    // No row at all is not the same as an unresolved row, but it lands in the
    // same place: nobody has looked yet, so the tender is not cleared.
    if (!finding) {
      open_questions.push({ key: req.key, label: req.label, reason: "not read yet" });
      continue;
    }
    if (finding.status === "not_stated") continue;
    if (finding.status === "met") continue;

    if (finding.status === "not_met") {
      blockers.push({
        key: req.key,
        label: req.label,
        stated: finding.stated ?? "",
        our_evidence: finding.our_evidence ?? "",
      });
      continue;
    }
    if (finding.status === "rejected") {
      open_questions.push({
        key: req.key,
        label: req.label,
        // Surface the verification failure verbatim. "Unresolved" with no
        // reason is what teaches people to switch the check off.
        reason: finding.rejected_reason || "the citation could not be verified",
      });
      continue;
    }
    open_questions.push({
      key: req.key,
      label: req.label,
      reason: finding.our_evidence ? "our evidence does not settle it" : "nothing recorded on our side",
    });
  }

  const families = rollUp(mandatory, byKey);
  const scoredAnswered = scored.filter((r) => {
    const f = byKey.get(r.key);
    return f && f.status !== "rejected" && f.status !== "unknown";
  }).length;

  let verdict: Verdict;
  let reason: string;

  if (mandatory.length === 0) {
    verdict = "unknown";
    reason = "no mandatory requirements have been loaded for this tender yet";
  } else if (blockers.length > 0) {
    verdict = "no_go";
    // Name the first blocker in the sentence. A verdict that makes someone
    // open a second screen to learn why is a verdict they will ignore.
    reason =
      blockers.length === 1
        ? `${blockers[0].label} is mandatory and we do not meet it`
        : `${blockers.length} mandatory requirements are not met, starting with ${blockers[0].label}`;
  } else if (open_questions.length > 0) {
    verdict = "blocked";
    reason =
      open_questions.length === 1
        ? `${open_questions[0].label} is unresolved: ${open_questions[0].reason}`
        : `${open_questions.length} mandatory requirements are unresolved, starting with ${open_questions[0].label}`;
  } else {
    verdict = "go";
    const count = mandatory.filter((r) => imposed(byKey.get(r.key)?.status ?? "")).length;
    reason =
      count === 0
        ? "this tender imposes no mandatory selection criteria we do not already meet"
        : `all ${count} mandatory requirements are met`;
  }

  return { verdict, reason, blockers, open_questions, families, scored: { answered: scoredAnswered, total: scored.length } };
}

function rollUp(mandatory: RequirementRow[], byKey: Map<string, FindingRow>): FamilyRoll[] {
  const seen = new Map<string, FamilyRoll>();

  for (const req of mandatory) {
    const family = req.family || "other";
    const roll =
      seen.get(family) ?? { family, met: 0, total: 0, state: "not_applicable" as FamilyRoll["state"] };
    seen.set(family, roll);

    const status = byKey.get(req.key)?.status;

    // A requirement the tender does not impose is not a hurdle we cleared, so
    // it is left out of the denominator entirely. "2/2" has to mean two real
    // bars cleared, or the fraction is decoration.
    if (status && !imposed(status)) continue;

    roll.total++;
    if (status === "met") roll.met++;
    else if (status === "not_met") roll.state = "blocked";
    else if (roll.state !== "blocked") roll.state = "unknown";
  }

  for (const roll of seen.values()) {
    if (roll.total === 0) roll.state = "not_applicable";
    else if (roll.state !== "blocked" && roll.met === roll.total) roll.state = "pass";
  }

  return [...seen.values()].sort(
    (a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family),
  );
}

/**
 * Calendar days from `now` until an ISO-ish date, or null when there is no date.
 *
 * Calendar days, not elapsed hours. Someone looking at this on the 20th with a
 * deadline on the 24th is owed "4 days", and would get "5" from a duration
 * rounded up, or "3" from one rounded down, depending on the time of day they
 * happened to look. A countdown that changes because it is now the afternoon
 * is a countdown people stop trusting.
 *
 * Negative means it has passed, and the caller is expected to say so rather
 * than hide it: a closed clarification window changes what you can still do
 * about an unresolved requirement, which is exactly when people need telling.
 */
export function daysUntil(when: string, now: Date = new Date()): number | null {
  const parsed = Date.parse(when.length === 10 ? `${when}T00:00:00Z` : when);
  if (!when || Number.isNaN(parsed)) return null;
  const target = new Date(parsed);
  const midnight = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((midnight(target) - midnight(now)) / 86_400_000);
}

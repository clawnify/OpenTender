// The second read: checking the one answer nothing else can check.
//
// Every finding this app stores is verified against the document text, except
// one. `not_stated` means "this tender does not impose that requirement", and
// it needs no quote, because there is nothing to quote. That is the honest
// design — the alternative is an agent inventing a threshold rather than
// admitting the pack is silent — but it leaves exactly one way to clear a
// mandatory requirement on an assertion: say it was never asked for.
//
// So the app reads the pack again, for those rows only, with a decision model.
// It is asked one closed question per requirement per page ("does this page
// impose that?") and answers with a probability. Nothing is generated, so
// there is no prose to parse and no verdict outside the set.
//
// Three properties of the model shape the code below.
//
//  1. Questions are almost free. Latency is roughly flat in question count
//     because it is one parallel pass, so every unresolved requirement is
//     asked about each page at once, and the number of calls is the number of
//     pages regardless of how many rows are being checked.
//  2. A `noul` answer IS its own confidence (|p-0.5|*2), so the probability is
//     the only number to read. Gating on a separate confidence would
//     double-count the same evidence.
//  3. It is a good first-pass filter over short text and a weak final
//     classifier over a long document. Its published failure mode is
//     precision: flags that are not real. A false flag here turns a cleared
//     row into one a human has to re-read, so the threshold is deliberately
//     high and the outcome is never a failure — only a return to unresolved.
//
// On data residency: what crosses the boundary is the buyer's own published
// tender text and the label of a published question set. No capability
// profile, no org data, nothing private to the deployment. That is what makes
// this safe to run from any region; widen the state to include our own side of
// the answer and that stops being true.

/** Pinned. The alias moves, and any number tuned below is tuned against this build. */
export const JEV_MODEL = "typesafe/jev-1.13";

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/**
 * Flag only when the model is near-certain.
 *
 * A starting point, not a calibration. It was chosen after four answers on one
 * document, which came back at 0.99 and 0.98 for requirements the text does
 * impose and 0.03 and below for ones it does not, so 0.85 sits in the gap
 * those four left rather than where answers were seen to cluster. Four is not
 * a corpus. Treat this number as provisional until it has been run against a
 * real set of packs with known answers.
 *
 * Which way to be wrong is not symmetric, and that is what set the direction.
 * The published weakness of this model class is precision, and every false
 * flag here is a cleared row a human has to re-read, so the threshold is high
 * on purpose: it loses real catches rather than filling the unresolved list
 * with noise, because a noisy check is one people switch off.
 */
export const IMPOSED_THRESHOLD = 0.85;

/** How many pages one sweep will read. A long pack costs one call per page. */
export const MAX_PAGES_PER_SWEEP = 400;

/**
 * Pages read at once.
 *
 * Six because that is the platform ceiling, not because it was tuned: a Worker
 * may have at most six connections simultaneously waiting for response
 * headers. Raising this does not go faster, it queues, so the number is a
 * limit being respected rather than a knob.
 */
const CONCURRENCY = 6;

export interface DecisionsEnv {
  /** Resolved per org at deploy time; absent off-platform, and the check is then simply off. */
  OPENROUTER_API_KEY?: string;
}

export interface CheckablePage {
  page_no: number;
  text: string;
}

export interface CheckableRequirement {
  key: string;
  label: string;
  hint: string;
}

export interface ImposedFlag {
  key: string;
  page_no: number;
  probability: number;
}

export function decisionsAvailable(env: DecisionsEnv): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
}

/**
 * Which of these requirements does the document actually impose?
 *
 * Returns one flag per requirement at most, on the page that argued for it
 * most strongly, and only above the threshold. A requirement the text really
 * is silent about produces nothing, which is the common case and the one that
 * must stay quiet.
 */
export async function findImposed(
  env: DecisionsEnv,
  pages: CheckablePage[],
  requirements: CheckableRequirement[],
): Promise<ImposedFlag[]> {
  if (!decisionsAvailable(env) || pages.length === 0 || requirements.length === 0) return [];

  const questions: Record<string, { type: string; instructions: string }> = {};
  for (const req of requirements) {
    // The wording is the whole specification: it is read literally and nothing
    // is remembered between calls. "Place an obligation on the supplier" is
    // deliberately narrower than "mention" — a tender that names ISO 9001 in a
    // list of things it does NOT require would answer yes to the looser
    // question, and every such mention would become a false flag.
    questions[req.key] = {
      type: "noul",
      instructions: `Does this text place an obligation on the supplier about ${lower(req.label)}? ${req.hint} Answer yes only if the text sets a requirement, condition or threshold the supplier must satisfy, not if it merely mentions the subject.`,
    };
  }

  const best = new Map<string, ImposedFlag>();
  const scanned = pages.slice(0, MAX_PAGES_PER_SWEEP);

  for (let i = 0; i < scanned.length; i += CONCURRENCY) {
    const batch = scanned.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((page) => askPage(env, page, questions)));

    for (let j = 0; j < results.length; j++) {
      const answers = results[j];
      if (!answers) continue;
      const page = batch[j];

      for (const [key, probability] of Object.entries(answers)) {
        if (probability < IMPOSED_THRESHOLD) continue;
        const current = best.get(key);
        if (!current || probability > current.probability) {
          best.set(key, { key, page_no: page.page_no, probability });
        }
      }
    }
  }

  return [...best.values()].sort((a, b) => b.probability - a.probability);
}

/**
 * One page, every question. A failure returns null rather than throwing: this
 * is a second opinion, and losing it must never cost the caller its write.
 */
async function askPage(
  env: DecisionsEnv,
  page: CheckablePage,
  questions: Record<string, { type: string; instructions: string }>,
): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: JEV_MODEL, state: page.text, questions }),
    });
    if (!res.ok) return null;

    const body = (await res.json()) as {
      answers?: Record<string, { type?: string; noul?: number }>;
    };
    if (!body.answers) return null;

    const out: Record<string, number> = {};
    for (const [key, answer] of Object.entries(body.answers)) {
      // Answers are keyed by question id, so there is no positional index to
      // misalign — but a malformed one is still skipped rather than read as 0.
      if (typeof answer?.noul === "number") out[key] = answer.noul;
    }
    return out;
  } catch {
    return null;
  }
}

/** "Cyber Essentials certification" reads better mid-sentence than at its start. */
function lower(label: string): string {
  return label.length > 1 && label[1] === label[1].toLowerCase()
    ? label[0].toLowerCase() + label.slice(1)
    : label;
}

// Citation verification — the rule this whole app exists to enforce.
//
// A model asked to "cite your source" will, often enough to matter, produce a
// quote that reads perfectly and appears nowhere in the document. In most
// domains that is an annoyance. In a diligence review it is the failure mode
// that makes the tool unusable, because a wrong answer with a page number
// attached is more dangerous than no answer at all — it survives review.
//
// So the API does not ask for a citation, it *checks* one: an answer is only
// stored as `answered` if its quote can be located in the extracted text of the
// document. Everything else is stored as `rejected` and rendered as unresolved.
// The check is mechanical, so no amount of prompt drift can weaken it.

/** Shorter than this and a "quote" isn't evidence — it's a coincidence. */
export const MIN_QUOTE_CHARS = 12;

/**
 * Fold the cosmetic differences between what a PDF extractor emits and what a
 * model transcribes, without folding away anything that changes meaning.
 *
 * Deliberately NOT folded: digits, letters, negations. Only characters that
 * PDF/Word mangle in transit — smart quotes, dash variants, ligatures, soft
 * hyphens and whitespace — plus case.
 *
 * NFKC does most of the invisible work: it collapses the exotic space
 * characters (NBSP, thin, narrow-NBSP) to a plain space and expands ligatures
 * (ﬁ -> "fi"), which is exactly the noise PDF extraction introduces. What
 * it leaves alone — quotes, dashes, soft hyphens — is handled explicitly below.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    // A hyphen at end of line is the extractor breaking a word, not a real
    // hyphen: "indemni-\nfication" is one word. Undo it before whitespace is
    // collapsed, while the line break is still there to identify it.
    .replace(/(\p{L})[-­]\s*\n\s*(\p{L})/gu, "$1$2")
    // Soft hyphens anywhere else are invisible and carry no meaning.
    .replace(/­/g, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * `normalize`, with every space removed as well.
 *
 * This is what containment is actually tested against, because PDF text
 * extraction does not preserve word boundaries reliably: pdf.js emits
 * "in accordanc\ne with" for text laid out across a line break, and inserts
 * spurious spaces inside words whenever a PDF uses per-character positioning
 * ("T his A greement"). A reviewer quoting that sentence correctly would be
 * told their quote was invented — the exact false rejection that teaches people
 * to switch verification off.
 *
 * Ignoring spaces costs almost nothing in strictness. Every other character
 * must still match in order, so two genuinely different passages of quotable
 * length cannot collide; what it gives up is only the ability to distinguish
 * texts that differ *solely* in where the spaces fall.
 */
function fingerprint(text: string): string {
  return normalize(text).replace(/ /g, "");
}

export type VerifyResult =
  | { ok: true; page: number }
  | { ok: false; reason: string; foundOnPage?: number };

export interface PageText {
  page_no: number;
  text: string;
}

/**
 * Is `quote` actually present in `pages`, on the page the caller claimed?
 *
 * When it is present but on a *different* page, say so rather than just
 * failing. Off-by-one page numbering — a cover page, a 0-indexed extractor —
 * is the most common honest mistake, and an error that names the right page
 * turns a retry loop into a single correction.
 */
export function verifyQuote(
  quote: string,
  claimedPage: number | null | undefined,
  pages: PageText[],
): VerifyResult {
  const trimmed = quote.trim();
  if (!trimmed) {
    return { ok: false, reason: "quote is empty — cite the sentence the answer comes from" };
  }
  if (trimmed.length < MIN_QUOTE_CHARS) {
    return {
      ok: false,
      reason: `quote is ${trimmed.length} characters; at least ${MIN_QUOTE_CHARS} are needed for it to identify a passage`,
    };
  }
  if (pages.length === 0) {
    return {
      ok: false,
      reason: "document has no extracted text yet — wait for extract_status to be ready",
    };
  }

  const needle = fingerprint(trimmed);
  const match = locate(needle, pages);

  if (!match) {
    return {
      ok: false,
      reason: "quote does not appear anywhere in this document's extracted text",
    };
  }
  if (claimedPage == null) {
    // Located it, and the caller didn't claim a page — adopt the real one.
    return { ok: true, page: match.pages[0] };
  }
  if (!match.pages.includes(claimedPage)) {
    const elsewhere =
      match.pages.length > 1
        ? `; it appears on ${match.pages.length} other pages (first: ${match.pages[0]})`
        : "";
    return {
      ok: false,
      reason: `quote was not found on page ${claimedPage}${elsewhere}`,
      foundOnPage: match.pages[0],
    };
  }
  return { ok: true, page: claimedPage };
}

/**
 * Find the quote, allowing it to straddle a page break.
 *
 * Contract clauses run across pages constantly — a governing-law paragraph
 * that starts at the foot of page 4 and finishes on page 5 is ordinary, not an
 * edge case. Checking pages only in isolation would reject those correct
 * citations, which is exactly the false negative that would push a user to
 * turn verification off.
 *
 * Returns **every** page the quote occurs on, not just the first.
 *
 * That distinction is load-bearing. Contracts repeat themselves relentlessly —
 * defined terms, running headers, a covenant restated in every schedule — so a
 * passage quoted from page 700 is frequently also present on page 1. Returning
 * only the first hit meant a reviewer who cited the page they actually read was
 * told their quote "was not found" there. That is a false rejection in the one
 * guarantee this app makes, and boilerplate would have triggered it constantly.
 *
 * Also returns both pages when the quote straddles a page break; citing either
 * end of a spanning quote is defensible, so both are accepted.
 */
function locate(needle: string, pages: PageText[]): { pages: number[] } | null {
  const prints = pages.map((p) => ({ page_no: p.page_no, text: fingerprint(p.text) }));

  const hits = prints.filter((p) => p.text.includes(needle)).map((p) => p.page_no);
  if (hits.length) return { pages: hits };

  for (let i = 0; i < prints.length - 1; i++) {
    if ((prints[i].text + prints[i + 1].text).includes(needle)) {
      return { pages: [prints[i].page_no, prints[i + 1].page_no] };
    }
  }
  return null;
}

import { describe, it, expect } from "vitest";
import { normalize, verifyQuote, MIN_QUOTE_CHARS } from "./citations.js";

const pages = [
  { page_no: 1, text: "MUTUAL NON-DISCLOSURE AGREEMENT\n\nThis Agreement is entered into as of 1 March 2026." },
  {
    page_no: 2,
    text:
      "3. Governing Law. This Agreement shall be governed by and construed in\n" +
      "accordance with the laws of the State of New York, without regard to its\n" +
      "conflict of laws principles.",
  },
  {
    page_no: 3,
    text: "4. Term. The obligations of confidentiality shall survive for a period of\nthree (3) years from the Effective Date.",
  },
];

describe("normalize", () => {
  it("folds the noise a PDF extractor introduces", () => {
    expect(normalize("  Governing   Law  ")).toBe("governing law");
    expect(normalize("the “Disclosing Party”")).toBe('the "disclosing party"');
    expect(normalize("arm’s length")).toBe("arm's length");
    expect(normalize("2026–2027")).toBe("2026-2027");
  });

  it("rejoins a word the extractor split across a line", () => {
    expect(normalize("indemni-\nfication obligations")).toBe("indemnification obligations");
  });

  it("keeps a real hyphen inside a line", () => {
    expect(normalize("non-disclosure")).toBe("non-disclosure");
  });

  it("does not fold anything that changes meaning", () => {
    expect(normalize("shall not be liable")).not.toBe(normalize("shall be liable"));
    expect(normalize("three (3) years")).not.toBe(normalize("five (5) years"));
  });
});

describe("verifyQuote", () => {
  it("accepts a quote present on the cited page", () => {
    const r = verifyQuote("governed by and construed in accordance with the laws of the State of New York", 2, pages);
    expect(r).toEqual({ ok: true, page: 2 });
  });

  it("accepts across the extractor's line breaks", () => {
    // The model transcribes flowing prose; the extractor emits hard wraps.
    const r = verifyQuote("survive for a period of three (3) years from the Effective Date", 3, pages);
    expect(r.ok).toBe(true);
  });

  it("tolerates a word the extractor split with no hyphen", () => {
    // Observed from pdf.js on a real upload: it breaks mid-word at the line
    // wrap and emits no hyphen, so "accordance" arrives as "accordanc\ne".
    const mangled = [
      {
        page_no: 1,
        text: "2. Governing Law. This Agreement shall be governed by and construed in accordanc\ne with the laws of the Republic of Singapore.",
      },
    ];
    const r = verifyQuote("construed in accordance with the laws of the Republic of Singapore", 1, mangled);
    expect(r.ok).toBe(true);
  });

  it("tolerates spurious spaces inside words", () => {
    // The other half of the same problem: per-character positioning in a PDF
    // makes the extractor emit "T his A greement".
    const spaced = [{ page_no: 1, text: "T his A greement is govern ed by the laws of Ir eland." }];
    expect(verifyQuote("This Agreement is governed by the laws of Ireland", 1, spaced).ok).toBe(true);
  });

  it("rejects a fabricated quote outright", () => {
    const r = verifyQuote("governed by the laws of the State of Delaware", 2, pages);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/does not appear anywhere/);
      expect(r.foundOnPage).toBeUndefined();
    }
  });

  it("names the right page when only the page number was wrong", () => {
    const r = verifyQuote("the laws of the State of New York", 1, pages);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.foundOnPage).toBe(2);
  });

  it("adopts the located page when none was claimed", () => {
    const r = verifyQuote("the laws of the State of New York", null, pages);
    expect(r).toEqual({ ok: true, page: 2 });
  });

  it("accepts a clause that runs across a page break", () => {
    // The commonest shape in a real contract: the sentence starts at the foot
    // of one page and finishes at the top of the next.
    const split = [
      { page_no: 4, text: "8. Indemnity. The Supplier shall indemnify the Customer against all" },
      { page_no: 5, text: "losses arising from any breach of clause 6 (Data Protection)." },
    ];
    const quote = "shall indemnify the Customer against all losses arising from any breach of clause 6";
    expect(verifyQuote(quote, 4, split).ok).toBe(true);
    // Citing either end of a spanning quote is defensible.
    expect(verifyQuote(quote, 5, split).ok).toBe(true);
    expect(verifyQuote(quote, 9, split).ok).toBe(false);
  });

  it("accepts a repeated passage on whichever page it was read from", () => {
    // Contracts restate covenants in every schedule, so a passage quoted from
    // page 700 is usually also on page 1. Matching only the first occurrence
    // rejected the reviewer who cited the page they actually read.
    const repeated = [
      { page_no: 1, text: "The Borrower shall not incur additional Indebtedness without consent." },
      { page_no: 400, text: "The Borrower shall not incur additional Indebtedness without consent." },
      { page_no: 700, text: "The Borrower shall not incur additional Indebtedness without consent." },
    ];
    const quote = "shall not incur additional Indebtedness without consent";
    for (const page of [1, 400, 700]) {
      expect(verifyQuote(quote, page, repeated).ok).toBe(true);
    }
    // A page it genuinely isn't on is still refused, and the hint says where.
    const miss = verifyQuote(quote, 250, repeated);
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.foundOnPage).toBe(1);
      expect(miss.reason).toMatch(/appears on 3 other pages/);
    }
  });

  it("refuses a quote too short to identify a passage", () => {
    const r = verifyQuote("New York", 2, pages);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(new RegExp(`${MIN_QUOTE_CHARS}`));
  });

  it("refuses to verify against a document with no extracted text", () => {
    const r = verifyQuote("the laws of the State of New York", 1, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no extracted text/);
  });
});

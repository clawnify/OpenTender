import { afterEach, describe, expect, it, vi } from "vitest";
import { IMPOSED_THRESHOLD, JEV_MODEL, decisionsAvailable, findImposed } from "./decisions.js";

const REQ = [{ key: "cyber_essentials", label: "Cyber Essentials certification", hint: "Which scheme level." }];
const PAGES = [
  { page_no: 1, text: "Section 1. Scope of the contract." },
  { page_no: 2, text: "Section 4.4. Cyber Essentials Plus is mandatory." },
];

/** Answer each page from a map of page_no → probability for the one question. */
function stubPages(byPage: Record<number, number>, status = 200) {
  const calls: { model: string; state: string; questions: Record<string, { instructions: string }> }[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as (typeof calls)[number];
    calls.push(body);
    const page = findPage(body.state);
    return {
      ok: status === 200,
      status,
      json: async () => ({
        model: JEV_MODEL,
        answers: { cyber_essentials: { type: "noul", noul: byPage[page] ?? 0 } },
      }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** The stub has only the state text to identify a page by, same as the model. */
function findPage(state: string): number {
  return PAGES.find((p) => p.text === state)?.page_no ?? 0;
}

afterEach(() => vi.unstubAllGlobals());

describe("decisionsAvailable", () => {
  it("is off without a key, so a deployment that has none simply lacks the check", () => {
    expect(decisionsAvailable({})).toBe(false);
    expect(decisionsAvailable({ OPENROUTER_API_KEY: "sk-test" })).toBe(true);
  });
});

describe("findImposed", () => {
  const env = { OPENROUTER_API_KEY: "sk-test" };

  it("never calls out when there is no key", async () => {
    const calls = stubPages({ 2: 0.99 });
    expect(await findImposed({}, PAGES, REQ)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns nothing when the document is genuinely silent", async () => {
    stubPages({ 1: 0.02, 2: 0.04 });
    expect(await findImposed(env, PAGES, REQ)).toEqual([]);
  });

  it("flags the page that imposes the requirement", async () => {
    stubPages({ 1: 0.02, 2: 0.99 });
    expect(await findImposed(env, PAGES, REQ)).toEqual([
      { key: "cyber_essentials", page_no: 2, probability: 0.99 },
    ]);
  });

  it("keeps the strongest page when several argue for it", async () => {
    stubPages({ 1: 0.88, 2: 0.97 });
    const flags = await findImposed(env, PAGES, REQ);
    expect(flags).toHaveLength(1);
    expect(flags[0].page_no).toBe(2);
  });

  it("holds the line just under the threshold", async () => {
    // The pin that matters: this gate's failure mode is false flags, and each
    // one is a cleared row a human has to re-read. Loosening the threshold
    // must be a deliberate edit, not a drift.
    stubPages({ 2: IMPOSED_THRESHOLD - 0.01 });
    expect(await findImposed(env, PAGES, REQ)).toEqual([]);

    stubPages({ 2: IMPOSED_THRESHOLD });
    expect(await findImposed(env, PAGES, REQ)).toHaveLength(1);
  });

  it("asks about a requirement only in terms the text can settle", async () => {
    const calls = stubPages({ 2: 0.99 });
    await findImposed(env, PAGES, REQ);
    const asked = calls[0].questions.cyber_essentials.instructions;
    // The wording IS the specification here: it is read literally and nothing
    // carries between calls. A tender that lists a certificate it does NOT
    // require would flag on "mention", so the question must ask for an
    // obligation.
    expect(asked).toContain("place an obligation on the supplier");
    expect(asked).toContain("not if it merely mentions the subject");
    expect(asked).toContain("Which scheme level.");
  });

  it("stays quiet when the service fails, rather than costing the caller its write", async () => {
    stubPages({ 2: 0.99 }, 503);
    expect(await findImposed(env, PAGES, REQ)).toEqual([]);
  });

  it("skips a malformed answer instead of reading it as zero or as a flag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ answers: { cyber_essentials: {} } }) }) as unknown as Response),
    );
    expect(await findImposed(env, PAGES, REQ)).toEqual([]);
  });

  it("pins the model build the threshold was calibrated against", async () => {
    // The alias moves and a threshold is calibrated against one build, so the
    // request must name the pinned id rather than the moving alias.
    const calls = stubPages({ 2: 0.99 });
    await findImposed(env, PAGES, REQ);
    expect(calls[0].model).toBe("typesafe/jev-1.13");
    expect(JEV_MODEL).toBe("typesafe/jev-1.13");
  });
});

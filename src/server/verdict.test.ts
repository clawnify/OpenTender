import { describe, expect, it } from "vitest";
import { buildVerdict, daysUntil, type FindingRow, type RequirementRow } from "./verdict.js";

const req = (key: string, over: Partial<RequirementRow> = {}): RequirementRow => ({
  key,
  label: key.replace(/_/g, " "),
  family: "technical",
  obligation: "mandatory",
  ...over,
});

const found = (key: string, status: string, over: Partial<FindingRow> = {}): FindingRow => ({
  requirement_key: key,
  status,
  ...over,
});

describe("buildVerdict", () => {
  it("says go when every mandatory requirement is met", () => {
    const r = buildVerdict(
      [req("turnover", { family: "economic" }), req("cyber_essentials")],
      [found("turnover", "met"), found("cyber_essentials", "met")],
    );
    expect(r.verdict).toBe("go");
    expect(r.reason).toBe("all 2 mandatory requirements are met");
    expect(r.blockers).toEqual([]);
  });

  it("says no-go on a single unmet mandatory requirement, and names it", () => {
    const r = buildVerdict(
      [req("turnover", { family: "economic" }), req("cyber_essentials", { label: "Cyber Essentials Plus" })],
      [
        found("turnover", "met"),
        found("cyber_essentials", "not_met", { stated: "Cyber Essentials Plus", our_evidence: "not held" }),
      ],
    );
    expect(r.verdict).toBe("no_go");
    expect(r.reason).toBe("Cyber Essentials Plus is mandatory and we do not meet it");
    expect(r.blockers).toEqual([
      { key: "cyber_essentials", label: "Cyber Essentials Plus", stated: "Cyber Essentials Plus", our_evidence: "not held" },
    ]);
  });

  it("outranks unresolved rows with a hard blocker", () => {
    // A tender with both should read as no-go, not as "still working on it":
    // the blocker is decided and no amount of further reading changes it.
    const r = buildVerdict(
      [req("insurance"), req("references")],
      [found("insurance", "not_met"), found("references", "unknown")],
    );
    expect(r.verdict).toBe("no_go");
  });

  it("blocks, rather than passing, when nobody has read a requirement yet", () => {
    const r = buildVerdict([req("turnover"), req("references")], [found("turnover", "met")]);
    expect(r.verdict).toBe("blocked");
    expect(r.open_questions).toEqual([{ key: "references", label: "references", reason: "not read yet" }]);
  });

  it("surfaces a failed citation verbatim instead of calling it unknown", () => {
    const r = buildVerdict(
      [req("turnover")],
      [found("turnover", "rejected", { rejected_reason: "quote was not found on page 14" })],
    );
    expect(r.verdict).toBe("blocked");
    expect(r.open_questions[0].reason).toBe("quote was not found on page 14");
  });

  it("treats a requirement the tender never states as no hurdle at all", () => {
    // Silence is not failure. If this blocked, every short pack would read
    // no-go and the verdict would stop being believed.
    const r = buildVerdict(
      [req("turnover"), req("social_value", { family: "social_value" })],
      [found("turnover", "met"), found("social_value", "not_stated")],
    );
    expect(r.verdict).toBe("go");
    expect(r.reason).toBe("all 1 mandatory requirements are met");
  });

  it("keeps unimposed requirements out of the family denominator", () => {
    const r = buildVerdict(
      [
        req("turnover", { family: "economic" }),
        req("insurance", { family: "economic" }),
        req("social_value", { family: "social_value" }),
      ],
      [found("turnover", "met"), found("insurance", "not_stated"), found("social_value", "not_stated")],
    );
    const economic = r.families.find((f) => f.family === "economic");
    expect(economic).toMatchObject({ met: 1, total: 1, state: "pass" });
    // A family this tender does not test at all should not render as 0/0 failed.
    expect(r.families.find((f) => f.family === "social_value")).toMatchObject({
      total: 0,
      state: "not_applicable",
    });
  });

  it("orders families the way a reviewer reads them", () => {
    const r = buildVerdict(
      [req("a", { family: "technical" }), req("b", { family: "economic" }), req("c", { family: "legal" })],
      [found("a", "met"), found("b", "met"), found("c", "met")],
    );
    expect(r.families.map((f) => f.family)).toEqual(["economic", "technical", "legal"]);
  });

  it("does not let scored criteria change the verdict", () => {
    const r = buildVerdict(
      [req("turnover"), req("method_statement", { obligation: "scored", weighting: "40%" })],
      [found("turnover", "met"), found("method_statement", "not_met")],
    );
    expect(r.verdict).toBe("go");
    expect(r.scored).toEqual({ answered: 1, total: 1 });
  });

  it("refuses to guess before any requirements are loaded", () => {
    const r = buildVerdict([], []);
    expect(r.verdict).toBe("unknown");
    expect(r.families).toEqual([]);
  });

  it("says go, not unknown, when a tender imposes no mandatory criteria", () => {
    const r = buildVerdict([req("turnover")], [found("turnover", "not_stated")]);
    expect(r.verdict).toBe("go");
    expect(r.reason).toBe("this tender imposes no mandatory selection criteria we do not already meet");
  });
});

describe("daysUntil", () => {
  const now = new Date("2026-09-20T09:00:00Z");

  it("counts whole days to a bare date", () => {
    expect(daysUntil("2026-09-24", now)).toBe(4);
  });

  it("gives the same answer whatever time of day it is asked", () => {
    // The bug this pins: an elapsed-duration count flips between 4 and 5
    // across a working day, so two people reading the same tender disagree.
    expect(daysUntil("2026-09-24", new Date("2026-09-20T23:30:00Z"))).toBe(4);
    expect(daysUntil("2026-09-24T09:00:00Z", new Date("2026-09-20T01:00:00Z"))).toBe(4);
  });

  it("goes negative once the window has closed", () => {
    expect(daysUntil("2026-09-18", now)).toBe(-2);
  });

  it("returns null for no date and for junk", () => {
    expect(daysUntil("", now)).toBeNull();
    expect(daysUntil("as soon as possible", now)).toBeNull();
  });
});

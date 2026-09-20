// The preview compositor.
//
// Writes standalone HTML for every carousel illustration and for the two
// README covers, into .preview-build/. Serve the repo root and capture each
// page at its declared size; nothing here launches a browser itself, so the
// capture step stays with whichever browser tool the run is using.
//
//   node scripts/previews.mjs
//   python3 -m http.server 4173     # from the repo root
//   ...capture each URL at its width x height, save to previews/
//
// The feature images are conceptual illustrations, not screenshot crops: the
// UI is rebuilt here at a size that reads in a carousel, with the content
// simplified to the one task each image is about. Everything they show is a
// capability the app actually has. The covers are different — they frame a
// real screenshot, because a cover claiming to be the app should be the app.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, ".preview-build");

/** House tokens, the same values as src/client/styles.css. */
const LIGHT = {
  bg: "#ffffff", surface: "#ffffff", sunken: "#f7f7f5", ink: "#1b1a19",
  muted: "#646360", faint: "#9a9893", border: "#e5e3de", accent: "#df3656",
  success: "#2b5f3c", successTint: "#dbf9e2", successSolid: "#319656",
  warning: "#664e27", warningTint: "#f9efdf", warningSolid: "#a3772b",
  danger: "#8a2f2d", dangerTint: "#f9edec", dangerSolid: "#e1363a",
  canvas: "linear-gradient(152deg, #fdf8f4 0%, #f6f1ee 46%, #efe9e6 100%)",
  glow: "radial-gradient(60% 60% at 76% 16%, rgba(223,54,86,0.13), transparent 70%)",
  shadow: "0 2px 4px rgba(38,30,28,.04), 0 18px 34px -12px rgba(38,30,28,.18), 0 42px 84px -32px rgba(38,30,28,.24)",
};

const DARK = {
  bg: "#100f0e", surface: "#161615", sunken: "#222120", ink: "#efeeed",
  muted: "#c0bdb9", faint: "#82807c", border: "#2e2e2c", accent: "#e4415d",
  success: "#86da9e", successTint: "#1a2b1f", successSolid: "#3c9c5d",
  warning: "#e5bd7e", warningTint: "#2d2518", warningSolid: "#a87e35",
  danger: "#e6b7b2", dangerTint: "#3b1c1a", dangerSolid: "#e64243",
  canvas: "linear-gradient(152deg, #171514 0%, #121110 50%, #0c0b0b 100%)",
  glow: "radial-gradient(60% 60% at 76% 16%, rgba(228,65,93,0.16), transparent 70%)",
  shadow: "0 2px 4px rgba(0,0,0,.30), 0 18px 34px -12px rgba(0,0,0,.55), 0 42px 84px -30px rgba(0,0,0,.65)",
};

const shell = ({ width, height, t, body, pad = 72 }) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    font-family: Inter, system-ui, sans-serif;
    color: ${t.ink};
    background-image: ${t.glow}, ${t.canvas};
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; padding: ${pad}px;
  }
  .headline { font-size: 46px; line-height: 1.12; font-weight: 640; letter-spacing: -.022em; max-width: 21ch; }
  .sub { margin-top: 14px; font-size: 21px; line-height: 1.45; color: ${t.muted}; max-width: 46ch; font-weight: 420; }
  .stage { position: relative; flex: 1; margin-top: 40px; }
  /* Every panel is placed and sized explicitly. An overlap computed from
     whatever height the content happened to reflow to is an overlap that
     lands on a different thing the next time the copy changes. */
  .nowrap { white-space: nowrap; }
  /* The front card owns the overlap: it stacks above and its shadow falls ON
     the card behind it. Without the explicit z-index the two shadows read as
     one flat seam and the pair looks like two rectangles touching rather than
     one card lifted over another. The heavier shadow is what sells the lift. */
  .lift {
    z-index: 2;
    box-shadow: 0 3px 6px rgba(38,30,28,.06), 0 22px 40px -10px rgba(38,30,28,.26),
                0 54px 96px -28px rgba(38,30,28,.32);
  }
  .lift-dark {
    z-index: 2;
    box-shadow: 0 3px 6px rgba(0,0,0,.4), 0 22px 40px -10px rgba(0,0,0,.62),
                0 54px 96px -26px rgba(0,0,0,.7);
  }

  .panel {
    position: absolute; background: ${t.surface}; border-radius: 18px;
    box-shadow: ${t.shadow}; overflow: hidden;
    outline: 1px solid ${t.border}; outline-offset: -1px;
  }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between; gap: 14px;
    padding: 18px 22px; border-bottom: 1px solid ${t.border};
  }
  .panel-title { font-size: 19px; font-weight: 600; letter-spacing: -.01em; }
  .row { display: flex; align-items: center; gap: 14px; padding: 15px 22px; border-bottom: 1px solid ${t.border}; }
  .row:last-child { border-bottom: 0; }
  .label { font-size: 17px; font-weight: 500; }
  .meta { font-size: 15px; color: ${t.muted}; }
  .faint { color: ${t.faint}; }
  .grow { flex: 1; min-width: 0; }
  .data { font-variant-numeric: tabular-nums; }

  .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 5px 13px; font-size: 14px; font-weight: 600; white-space: nowrap; }
  .b-danger { background: ${t.dangerTint}; color: ${t.danger}; }
  .b-success { background: ${t.successTint}; color: ${t.success}; }
  .b-warning { background: ${t.warningTint}; color: ${t.warning}; }
  .b-neutral { background: ${t.sunken}; color: ${t.muted}; }

  .track { height: 7px; width: 132px; border-radius: 999px; background: ${t.sunken}; overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; }

  .quote {
    background: ${t.sunken}; border-radius: 10px; padding: 14px 16px;
    font-size: 16px; line-height: 1.5; color: ${t.muted}; font-style: italic;
  }
  .cite { margin-top: 9px; font-size: 14px; color: ${t.faint}; font-style: normal; }
  mark { background: ${t.warningTint}; color: ${t.ink}; border-radius: 3px; padding: 1px 2px; }

  .btn {
    display: inline-flex; align-items: center; gap: 9px; border-radius: 10px;
    padding: 11px 17px; font-size: 16px; font-weight: 600;
  }
  .btn-quiet { background: ${t.surface}; color: ${t.ink}; outline: 1px solid ${t.border}; outline-offset: -1px; }
  .btn-pressed { background: ${t.sunken}; color: ${t.ink}; outline: 1px solid ${t.border}; outline-offset: -1px; transform: translateY(1px); }

  .field {
    display: flex; align-items: center; border-radius: 10px; background: ${t.surface};
    outline: 1px solid ${t.border}; outline-offset: -1px; padding: 11px 14px; font-size: 16px;
  }
  .field-focus { outline: 2px solid ${t.accent}; outline-offset: -2px; }
  .caret { display: inline-block; width: 2px; height: 20px; background: ${t.ink}; margin-left: 1px; }
  .cursor { position: absolute; pointer-events: none; z-index: 3; }
</style></head><body>${body}</body></html>`;

/**
 * The pointers, drawn inline.
 *
 * Each one says which action is happening, so they are never interchangeable:
 * the arrow clicks, the I-beam edits text. Both carry a white keyline so they
 * stay legible over ink, tint and white alike. Their hotspots differ — the
 * arrow points from its top-left, the I-beam centres on its stem — so x,y
 * means "where the action lands", not "where the box sits".
 */
const arrow = (x, y) => `<svg class="cursor" style="left:${x}px;top:${y}px" width="34" height="42" viewBox="0 0 34 42" fill="none">
  <path d="M4 3.2 L4 31.6 L11.1 25.2 L15.6 35.8 L21.2 33.4 L16.8 23.1 L26.3 22.4 Z"
        fill="#111" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/>
</svg>`;

const ibeam = (x, y) => `<svg class="cursor" style="left:${x - 9}px;top:${y - 20}px" width="18" height="40" viewBox="0 0 18 40" fill="none">
  <path d="M4 3 H14 M9 3 V37 M4 37 H14" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
  <path d="M4 3 H14 M9 3 V37 M4 37 H14" stroke="#111" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

const bar = (t, pct, colour) =>
  `<div class="track"><div class="fill" style="width:${pct}%;background:${colour}"></div></div>`;

// ── 1. The verdict. A read-out, so no pointer: a cursor resting on a number
//       has nothing to say. ────────────────────────────────────────────────
const verdict = (t) => shell({
  width: 1600, height: 1000, t,
  body: `
  <div class="headline">Go or no-go, and the one thing that decided it.</div>
  <div class="sub">The call is computed from the evidence every time it is read, so it can never disagree with the rows underneath it.</div>
  <div class="stage">
    <div class="panel" id="main" style="left:0;top:0;width:1080px">
      <div style="padding:26px 28px 22px">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="badge b-danger">No-go</span>
          <span class="meta">4 days to clarification window</span>
        </div>
        <div style="margin-top:14px;font-size:27px;font-weight:600;letter-spacing:-.015em;line-height:1.25">
          Cyber Essentials certification is mandatory and we do not meet it
        </div>
      </div>
      <div style="border-top:1px solid ${t.border};padding:20px 28px">
        ${[
          ["Economic and financial standing", 100, t.successSolid, "5/5", t.success],
          ["Technical capability", 33, t.dangerSolid, "1/3", t.danger],
          ["Professional standing", 100, t.successSolid, "1/1", t.success],
          ["Exclusion grounds", 100, t.successSolid, "1/1", t.success],
        ].map(([name, pct, colour, frac, textColour]) => `
        <div style="display:flex;align-items:center;gap:20px;padding:9px 0">
          <span class="grow label" style="font-weight:450">${name}</span>
          ${bar(t, pct, colour)}
          <span class="data" style="width:46px;text-align:right;font-size:17px;font-weight:600;color:${textColour}">${frac}</span>
        </div>`).join("")}
      </div>
      <div style="border-top:1px solid ${t.border};padding:16px 28px;display:flex;gap:28px">
        <span class="meta">Submission <b style="color:${t.ink};font-weight:600">14 Oct 2026</b></span>
        <span class="meta" style="color:${t.warning}">Clarifications close <b style="font-weight:600">24 Sep 2026</b></span>
      </div>
    </div>

    <div class="panel lift" id="second" style="left:700px;top:326px;width:756px;height:212px">
      <div class="panel-head"><span class="panel-title" style="color:${t.danger}">What stops this bid</span></div>
      <div style="padding:22px 24px">
        <div class="label" style="font-size:19px">Cyber Essentials certification</div>
        <div style="margin-top:14px;display:flex;gap:16px">
          <span class="meta nowrap" style="width:104px">They ask for</span>
          <span style="font-size:17px">Cyber Essentials <b>Plus</b>, at submission</span>
        </div>
        <div style="margin-top:10px;display:flex;gap:16px">
          <span class="meta nowrap" style="width:104px">We have</span>
          <span style="font-size:17px">Cyber Essentials (basic) only</span>
        </div>
      </div>
    </div>
  </div>`,
});

// ── 2. The citation. Also static: the point is that the evidence is there,
//       not that you are doing something to it. ──────────────────────────
const citation = (t) => shell({
  width: 1600, height: 1000, t,
  body: `
  <div class="headline">Every answer carries a quote the app can find.</div>
  <div class="sub">A quote that is not in the document is refused and shown as unresolved, never stored as an answer. The check is mechanical, so no amount of prompt drift weakens it.</div>
  <div class="stage">
    <div class="panel" style="left:0;top:20px;width:900px">
      <div class="panel-head">
        <span class="panel-title">Economic and financial standing</span>
        <span class="badge b-success">Met</span>
      </div>
      <div style="padding:20px 22px">
        <div class="label">Minimum economic and financial standing</div>
        <div style="margin-top:12px;display:flex;gap:14px">
          <span class="meta" style="width:96px">They ask for</span>
          <span style="font-size:16px">turnover of at least GBP 1,200,000 in each of the last two years</span>
        </div>
        <div style="margin-top:8px;display:flex;gap:14px">
          <span class="meta" style="width:96px">We have</span>
          <span style="font-size:16px">GBP 1.84m (FY2025), GBP 1.61m (FY2024)</span>
        </div>
        <div class="quote" style="margin-top:16px">
          “Tenderers must demonstrate a minimum general yearly turnover of GBP 1,200,000”
          <div class="cite">ITT-CCC-2026-ITS-041.txt, p.14</div>
        </div>
      </div>
    </div>

    <div class="panel lift" style="left:666px;top:286px;width:790px">
      <div class="panel-head">
        <span class="panel-title">ITT-CCC-2026-ITS-041.txt</span>
        <span class="meta data">p.14</span>
      </div>
      <div style="padding:22px;font-size:16px;line-height:1.75;color:${t.muted}">
        <div style="color:${t.ink};font-weight:600;margin-bottom:10px">4.1 Economic and financial standing</div>
        <mark>Tenderers must demonstrate a minimum general yearly turnover of GBP 1,200,000</mark>
        in each of the last two financial years. Audited accounts for the last two financial
        years must be available on request.
      </div>
    </div>
  </div>`,
});

// ── 3. The second read. A click, and the button is drawn pressed. ────────
const doubleCheck = (t) => shell({
  width: 1600, height: 1000, t,
  body: `
  <div class="headline">Double-check the one answer with no quote behind it.</div>
  <div class="sub">“This tender does not ask for that” is the only way to clear a requirement on an assertion. One pass re-reads the pack for exactly those rows.</div>
  <div class="stage">
    <div class="panel" style="left:150px;top:126px;width:1306px">
      <div class="panel-head">
        <span class="panel-title">Back on the list</span>
        <span class="badge b-warning">1 of 5 flagged</span>
      </div>
      <div class="row">
        <span class="grow label">Public liability insurance</span>
        <span class="badge b-warning">Unresolved</span>
      </div>
      <div style="padding:24px 26px 30px">
        <div class="quote" style="font-style:normal;color:${t.ink};font-size:17px">
          A second read of <b>ITT-CCC-2026-ITS-041.txt, page 14</b> suggests this tender does
          impose this requirement. Read that page and settle the row.
        </div>
        <div class="meta" style="margin-top:14px">Flagged rows come back as unresolved, never as failed.</div>
      </div>
    </div>

    <!-- The control that produced it, floating over its own result with the
         pointer on it. The button is drawn pressed, because a cursor over a
         control at rest is a cursor pasted on. -->
    <div class="panel lift" style="left:200px;top:66px;width:1000px">
      <div style="padding:22px 24px;display:flex;align-items:center;gap:20px">
        <span class="grow" style="font-size:17px;color:${t.muted}">5 requirements were cleared as not asked for.</span>
        <span class="btn btn-pressed">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg>
          Double-check
        </span>
      </div>
    </div>
    ${arrow(1040, 112)}
  </div>`,
});

// ── 4. The profile. A text edit, so the I-beam sits in a focused field with
//       its caret, and the pointer stays off the value it is about. ───────
const profile = (t) => shell({
  width: 1600, height: 1000, t,
  body: `
  <div class="headline">Answer once. Reuse it on every tender.</div>
  <div class="sub">What your company can evidence does not change per bid, so it does not live on one. An expiry is a column, because the expensive certificate is the one that lapsed in March.</div>
  <div class="stage">
    <div class="panel" style="left:0;top:20px;width:1030px">
      <div class="panel-head">
        <span class="panel-title">What we can evidence</span>
        <span class="meta data">13 of 17 answered</span>
      </div>
      <div style="padding:18px 22px 22px">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="label">Employers' liability insurance</span>
          <span class="badge b-neutral">Financial</span>
        </div>
        <div style="margin-top:14px;display:grid;grid-template-columns:2fr 2fr 1fr;gap:12px">
          <span class="field field-focus">GBP 10m<span class="caret"></span></span>
          <span class="field faint">Policy NW-EL-88120</span>
          <span class="field data">31/03/2027</span>
        </div>
      </div>
      <div class="row" style="border-top:1px solid ${t.border}">
        <span class="grow label" style="font-weight:450">Cyber Essentials</span>
        <span class="meta">Cyber Essentials (basic) only</span>
        <span class="badge b-neutral">expires 02/04/2027</span>
      </div>
      <div class="row">
        <span class="grow label" style="font-weight:450">Relevant contract examples</span>
        <span class="meta">3 managed-service contracts, 2 public sector</span>
      </div>
    </div>
    ${ibeam(112, 142)}

    <div class="panel lift" style="left:852px;top:300px;width:604px">
      <div class="panel-head"><span class="panel-title">Checked against</span></div>
      <div class="row">
        <span class="grow" style="font-size:16px">Employers' liability of at least GBP 5,000,000</span>
        <span class="badge b-success">Met</span>
      </div>
      <div class="row">
        <span class="grow" style="font-size:16px">Public liability of at least GBP 5,000,000</span>
        <span class="badge b-success">Met</span>
      </div>
      <div class="row">
        <span class="grow" style="font-size:16px">Professional indemnity of at least GBP 2,000,000</span>
        <span class="badge b-success">Met</span>
      </div>
    </div>
  </div>`,
});

// ── The covers. These frame the real screenshot: a cover claiming to be the
//    app should be the app. ────────────────────────────────────────────────
const cover = (t, shot, dark) => shell({
  width: 2560, height: 1600, t, pad: 0,
  body: `
  <div style="flex:1;display:flex;flex-direction:column;padding:104px 120px 0;overflow:hidden">
    <div style="display:flex;align-items:center;gap:20px">
      <img src="/icon.svg" width="72" height="72" alt="">
      <span style="font-size:44px;font-weight:680;letter-spacing:-.02em">OpenTender</span>
    </div>
    <div style="margin-top:44px;font-size:74px;line-height:1.08;font-weight:660;letter-spacing:-.026em;max-width:31ch">
      Know whether you can bid, before the deadline decides for you.
    </div>
    <div style="margin-top:26px;font-size:28px;line-height:1.45;color:${t.muted};max-width:60ch;font-weight:420">
      Bid/no-bid on a public tender, computed from evidence you can click through to.
    </div>
    <div style="position:relative;flex:1;margin-top:64px">
      <img src="/${shot}" width="2080" alt=""
           style="position:absolute;left:112px;top:0;border-radius:20px;box-shadow:${t.shadow};
                  outline:1px solid ${t.border};outline-offset:-1px">
      <div class="panel ${dark ? "lift-dark" : "lift"}" style="left:0;top:296px;width:560px">
        <div class="panel-head"><span class="panel-title" style="color:${t.danger};font-size:22px">What stops this bid</span></div>
        <div style="padding:22px 24px">
          <div style="font-size:20px;font-weight:600">Cyber Essentials certification</div>
          <div style="margin-top:12px;font-size:18px;color:${t.muted}">They ask for Plus. We hold basic.</div>
        </div>
      </div>
    </div>
  </div>`,
});

const PAGES = [
  { file: "verdict.html", html: verdict(LIGHT), width: 1600, height: 1000, png: "previews/verdict.png" },
  { file: "citation.html", html: citation(LIGHT), width: 1600, height: 1000, png: "previews/citation.png" },
  { file: "double-check.html", html: doubleCheck(LIGHT), width: 1600, height: 1000, png: "previews/double-check.png" },
  { file: "profile.html", html: profile(LIGHT), width: 1600, height: 1000, png: "previews/profile.png" },
  { file: "cover-light.html", html: cover(LIGHT, "screenshots/tender-verdict-light.png", false), width: 2560, height: 1600, png: "readme-banner.png" },
  { file: "cover-dark.html", html: cover(DARK, "screenshots/tender-verdict-dark.png", true), width: 2560, height: 1600, png: "readme-banner-dark.png" },
];

mkdirSync(out, { recursive: true });
for (const page of PAGES) {
  writeFileSync(resolve(out, page.file), page.html);
  console.log(`http://localhost:4173/.preview-build/${page.file}  ${page.width}x${page.height}  -> ${page.png}`);
}

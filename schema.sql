-- OpenTender: bid/no-bid on a public tender pack.
--
-- The shape of this schema is an argument. Every tender tool models the work as
-- "documents in, proposal out", so the document is the subject and the answer is
-- free text. Here the subject is the REQUIREMENT, because that is the unit a bid
-- is actually lost on: one mandatory certificate you do not hold, found on the
-- afternoon of the deadline.
--
-- Three consequences run through the tables below.
--
--  1. Requirements are rows, not prose. They come from a pack (a jurisdiction's
--     standard selection questions), are scoped to one tender, and each carries
--     its own obligation level, because "mandatory" and "scored" fail in
--     completely different ways.
--  2. What the buyer demands and what we can prove are kept apart. `findings`
--     holds the demand, read out of the pack with a verified citation.
--     `capabilities` holds our side, recorded once and reused across every
--     tender. A requirement is only `met` when both exist.
--  3. There is no stored verdict. It is computed from the findings every time
--     it is read, so it cannot drift away from the evidence underneath it.

CREATE TABLE IF NOT EXISTS tenders (
  id                      text primary key,
  name                    text not null,
  buyer                   text not null default '',          -- the contracting authority
  reference               text not null default '',          -- the buyer's own notice number
  lot                     text not null default '',          -- '' when the tender has no lots
  value                   text not null default '',          -- kept as text: packs quote ranges, "up to", per-annum
  currency                text not null default 'GBP',
  -- Two deadlines, because they are two different decisions. Missing the
  -- clarification window is the quieter loss: after it closes, an ambiguous
  -- requirement can no longer be resolved, only guessed at.
  deadline_at             text not null default '',
  clarification_deadline_at text not null default '',
  source_url              text not null default '',
  pack_id                 text not null default '',          -- which requirement pack seeded this tender
  status                  text not null default 'open',      -- open | submitted | abandoned | won | lost
  decision_note           text not null default '',          -- why a human overrode or accepted the verdict
  created_by              text not null default '',          -- platform user id, for the audit trail
  created_at              text not null default (datetime('now')),
  updated_at              text not null default (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tenders_status ON tenders (status, deadline_at);

-- ── The pack ────────────────────────────────────────────────────────
--
-- Documents and their extracted page text. Identical in shape to any document
-- review tool, and deliberately so: the page text is what every citation is
-- checked against, and that check is the only thing standing between this app
-- and a confident wrong answer.

CREATE TABLE IF NOT EXISTS documents (
  id             text primary key,
  tender_id      text not null references tenders (id) on delete cascade,
  name           text not null,
  -- What part the document plays. The agent reads these differently: selection
  -- criteria live in the SQ, deliverables in the specification, and the
  -- contract is where the penalties hide.
  kind           text not null default 'other',              -- itt | specification | sq | contract | pricing | other
  r2_key         text not null default '',                   -- where the original file lives
  mime           text not null default '',
  size_bytes     integer not null default 0,
  page_count     integer not null default 0,
  -- What page_no actually counts. A DOCX has no page 3, so a citation into one
  -- is labelled a block. Saying "page" for both would put a number next to a
  -- quote that nobody can turn back into a location in the original file.
  locator_kind   text not null default 'page',               -- page | block
  extract_status text not null default 'pending',            -- pending | ready | failed
  extract_error  text not null default '',
  created_at     text not null default (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_tender ON documents (tender_id);

CREATE TABLE IF NOT EXISTS document_pages (
  document_id text not null references documents (id) on delete cascade,
  page_no     integer not null,
  text        text not null default '',
  primary key (document_id, page_no)
);

-- ── Our side of the answer ──────────────────────────────────────────
--
-- The company profile: what we hold, what we have done, what we are insured
-- for. This table is why the app can say "no-go" rather than only "here is what
-- they asked for".
--
-- It is scoped to the deployment, not to a tender, because that is the whole
-- point: turnover and certifications are answered once and then reused for
-- every bid. `expires_at` exists because the most expensive version of this
-- mistake is not a missing certificate, it is one that lapsed in March.

CREATE TABLE IF NOT EXISTS capabilities (
  key         text primary key,                              -- stable handle a requirement can point at
  label       text not null,
  category    text not null default 'other',                 -- economic | technical | professional | legal | social_value | other
  value       text not null default '',                      -- "GBP 1.8m", "held", "3 contracts"
  evidence    text not null default '',                      -- where a human can go and check
  expires_at  text not null default '',                      -- '' when it does not expire
  notes       text not null default '',
  updated_at  text not null default (datetime('now'))
);

-- ── What the buyer demands ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS requirements (
  id             text primary key,
  tender_id      text not null references tenders (id) on delete cascade,
  position       integer not null default 0,
  key            text not null,                              -- stable handle the agent writes against
  label          text not null,
  family         text not null default 'other',              -- economic | technical | professional | legal | social_value | other
  -- The distinction the verdict is built on. A missing `mandatory` kills the
  -- bid outright; a weak `scored` only costs points, and a team that treats
  -- the two alike either bids on things it cannot win or walks away from
  -- things it could.
  obligation     text not null default 'mandatory',          -- mandatory | scored | optional
  weighting      text not null default '',                   -- '10%' for scored criteria, '' otherwise
  hint           text not null default '',                   -- what to look for in the pack
  capability_key text not null default '',                   -- which profile entry answers this, '' when none
  UNIQUE (tender_id, key)
);

CREATE INDEX IF NOT EXISTS idx_requirements_tender ON requirements (tender_id, position);

-- ── The answer, with its receipt ────────────────────────────────────
--
-- One finding per requirement. Not one per document: a requirement is a fact
-- about the tender, stated once, and a grid of requirement x document would be
-- mostly empty cells asking the agent to fill them.
--
-- `stated` is what the buyer demands, `quote` is the sentence it was read from,
-- and `page_no` is where. The quote is located in `document_pages` before the
-- row is written; a quote that cannot be found is stored `rejected` and
-- rendered as unresolved, never as an answer. `met` additionally requires a
-- capability on our side, so the app cannot pass a requirement on the strength
-- of having merely understood it.

CREATE TABLE IF NOT EXISTS findings (
  id              text primary key,
  requirement_id  text not null references requirements (id) on delete cascade,
  document_id     text references documents (id) on delete set null,
  stated          text not null default '',                  -- the threshold as the pack words it
  quote           text not null default '',
  page_no         integer,
  -- not_stated is the honest escape hatch, and it is load-bearing. Without it,
  -- an agent facing a pack that never mentions insurance has only one way to
  -- fill the row: invent a threshold. Make the truthful answer the easy one.
  status          text not null default 'unknown',           -- met | not_met | unknown | not_stated | rejected
  our_evidence    text not null default '',                  -- the capability value this was checked against
  rationale       text not null default '',
  rejected_reason text not null default '',
  updated_at      text not null default (datetime('now')),
  UNIQUE (requirement_id)
);

-- ── Agent handoff ───────────────────────────────────────────────────
--
-- Which of the org's agents reads the pack. Single row; '' lets the platform
-- resolve a single-agent org on its own.

CREATE TABLE IF NOT EXISTS agent_config (
  id         integer primary key check (id = 1),
  server_id  text not null default '',
  updated_at text default (datetime('now'))
);

INSERT OR IGNORE INTO agent_config (id, server_id) VALUES (1, '');

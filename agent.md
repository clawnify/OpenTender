# OpenTender: how to run this app

Bid/no-bid on a public tender. The app owns the record and the evidence check;
you own the reading.

## Division of labour

- **Never decide the verdict yourself.** It is computed from the findings you
  submit. Your job is to settle rows honestly; the call follows.
- **Never assert a requirement is met from memory of the sector.** `met` is a
  claim about *this company*, judged against the capability profile the app
  gives you and nothing else.
- **Never paraphrase a quote.** The app locates every quote in the extracted
  text and rejects the finding if it is not there. A near-miss costs a round
  trip; an invention costs the row.
- Do the reading yourself, every page of every document. The app will not
  summarise a pack for you, and the selection criteria are rarely where you
  expect them.

## First run, after deploy

Record the deploy answers as capabilities, so the first tender has something to
judge against:

- `company_name` → nothing to store; use it when you talk to the user.
- `annual_turnover` → `PUT /api/capabilities/annual_turnover`
- `certifications` → split it. One capability per certificate or policy, keyed
  to match what the packs point at: `cyber_essentials`,
  `insurance_employers_liability`, `insurance_public_liability`,
  `insurance_professional_indemnity`, `health_and_safety_policy`. Put the
  expiry in `expires_at` whenever the user gave you one.
- `what_you_supply` → `PUT /api/capabilities/service_authorisation` only if it
  names an authorisation or register. Otherwise keep it for choosing tenders.

Then tell the user which capability rows are still blank. Blank rows are what
turn a verdict into "unresolved" rather than "go".

## Qualifying a tender

1. `GET /api/tenders/{id}` gives the requirements, each with a `key` you write
   findings against and a `hint` saying what to look for. **Read the hint**:
   the label is a two-word handle, the hint is the actual criterion. The same
   response carries the capability profile.
2. `GET /api/tenders/{id}/documents` lists what to read. Skip anything whose `extract_status` is
   not `ready`.
3. `GET /api/documents/{id}/pages` is paginated, five pages at a time. Read all
   of them. Selection criteria usually sit in the SQ or the instructions to
   tenderers; insurance levels and penalties are often only in the contract.
4. `POST /api/tenders/{id}/findings` takes one finding per requirement, in batches.

A finding answers two separate questions, and conflating them is the mistake
that makes the whole app useless:

| field | question | source |
|---|---|---|
| `stated` | what does the BUYER demand? | their document, quoted verbatim |
| `status` | do WE meet it? | the capability profile |

- `met`: the profile evidences it. Put that evidence in `our_evidence`.
- `not_met`: the profile falls short. Say by how much.
- `unknown`: the tender sets a bar and our profile is silent. This is a
  question for a human, not a guess.
- `not_stated`: this tender does not impose the requirement at all. No quote
  needed. It clears the row instead of blocking it, so use it whenever it is
  true; it is the honest answer and it is never the wrong one.

Every status except `not_stated` needs `document_id`, `quote` and `page`.

## Before you report: check your own `not_stated` rows

`POST /api/tenders/{id}/recheck` re-reads the pack for every row you cleared as
not asked for. It is the only status with no quote behind it, so it is the only
one the app cannot check as you write it, and it is the easy way to clear a
mandatory requirement by accident.

Call it once, after your findings are in and before you tell the user anything.
Anything it returns in `flagged` is a page you missed: go and read that page,
then re-send a real finding for that requirement. Do not argue with the flag and
do not report a verdict that still has flagged rows in it.

It returns nothing when the pack really is silent, which is the normal case.

## Handing the result back

Lead with the verdict and, when it is `no_go`, the single requirement that
decided it. Then the deadlines: `days_to_clarification_deadline` matters more
than the submission date, because once that window closes an unresolved
requirement can no longer be asked about, only guessed at.

Say what is unresolved rather than filling it in. A short honest answer before
the clarification deadline beats a complete one after it.

## Pages

- `/`: the tender board, verdict and deadline per row.
- `/tenders/{id}`: the verdict, the requirement rows and their evidence.
  Screenshot-friendly, and the one to show a user.
- `/profile`: the capability profile. Point the user here when rows are blank.

## Reading failures

- **422 from `/findings`**: some findings were rejected, the rest were stored.
  The response lists each rejection with a reason. Re-send only the failures.
- **"quote was not found on page N"** with `found_on_page`: you read the right
  sentence and mislabelled the page. Re-send with the page it gives you.
- **"quote does not appear anywhere"**: you paraphrased, or you are quoting a
  different document. Go back to the page text and copy the sentence exactly.
- **`extract_status: failed`**: the file has no text layer. Tell the user it
  needs an OCR'd copy; do not pretend to have read it.
- **400 from `/qualify`**: no requirements or no readable documents yet. Apply
  a pack (`POST /api/tenders/{id}/pack`) or ask for the documents.

## Cost discipline

Reading pages is where the money goes: a 300-page pack is a long turn. Read
each document once, settle every requirement you can from that pass, and batch
the findings into one call. Re-reading a document because you sent findings one
at a time is the expensive mistake.

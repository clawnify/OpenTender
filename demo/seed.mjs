// Fictional data for a local demo, driven through the app's own API.
//
// Not SQL, deliberately. Every finding here goes through the same citation
// check a real one does, so a quote that drifts out of the fixture documents
// fails the seed instead of quietly producing a demo that shows evidence the
// app would have refused.
//
//   pnpm dev            # in one terminal
//   node demo/seed.mjs  # in another
//
// Fictional throughout: Northwind Services is not a company, and the two
// authorities are not running these procurements.

const API = process.env.API ?? "http://localhost:8789";

const ITT = `COVENTRY CITY COUNCIL
INVITATION TO TENDER
MANAGED IT SUPPORT AND NETWORK MAINTENANCE 2027-2030
Reference CCC-2026-ITS-041

SECTION 1 - THE REQUIREMENT

The Council seeks a supplier to provide managed IT support and network
maintenance across 41 sites for an initial term of three years.

SECTION 4 - SELECTION CRITERIA

4.1 Economic and financial standing
Tenderers must demonstrate a minimum general yearly turnover of GBP 1,200,000
in each of the last two financial years. Audited accounts for the last two
financial years must be available on request.

4.2 Insurance
The supplier shall hold employers' liability insurance of not less than
GBP 5,000,000 and public liability insurance of not less than GBP 5,000,000
for the duration of the contract.

4.3 Technical and professional ability
Tenderers must provide three examples of contracts of a similar scope and
scale delivered in the last three years, at least one of which must be for a
public sector body.

4.4 Cyber security
Certification to Cyber Essentials Plus is mandatory for this procurement and
must be held at the point of tender submission. Certification to the basic
Cyber Essentials scheme alone will not be accepted.

4.5 Professional registration
Tenderers must be registered with the appropriate professional or trade
register in the country in which they are established.

SECTION 6 - CLARIFICATIONS

All clarification questions must be submitted through the portal no later
than 24 September 2026. Questions received after that date will not be
answered.`;

const CONTRACT = `COVENTRY CITY COUNCIL
CONDITIONS OF CONTRACT - CCC-2026-ITS-041

CLAUSE 12 - SERVICE LEVELS AND DEDUCTIONS

12.1 The Supplier shall respond to a Priority 1 incident within thirty (30)
minutes of the incident being logged.

12.2 Where the Supplier fails to meet the response time in clause 12.1, the
Authority may deduct 2% of the monthly service charge for each occurrence, up
to a maximum of 20% of the monthly service charge in any one month.

CLAUSE 18 - INFORMATION GOVERNANCE

18.1 The Supplier shall process personal data only on the documented
instructions of the Authority and shall maintain a record of processing
activities in accordance with data protection legislation.

CLAUSE 24 - INSURANCE

24.1 The Supplier shall maintain professional indemnity insurance of not less
than GBP 2,000,000 for each and every claim throughout the term.`;

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: init.body instanceof FormData ? {} : { "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok && res.status !== 422) throw new Error(`${path} -> ${res.status} ${body.error ?? text}`);
  return body;
}

async function upload(tenderId, name, kind, text) {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "text/plain" }));
  form.append("kind", kind);
  const doc = await call(`/api/tenders/${tenderId}/documents`, { method: "POST", body: form });
  if (doc.extract_status !== "ready") throw new Error(`${name} did not extract: ${doc.extract_error}`);
  return doc;
}

const CAPABILITIES = {
  annual_turnover: { value: "GBP 1.84m (FY2025), GBP 1.61m (FY2024)", evidence: "Filed accounts, Companies House 04182233" },
  filed_accounts: { value: "Filed to 31 March 2026", evidence: "Companies House 04182233" },
  insurance_employers_liability: { value: "GBP 10m", evidence: "Policy NW-EL-88120", expires_at: "2027-03-31" },
  insurance_public_liability: { value: "GBP 10m", evidence: "Policy NW-PL-88121", expires_at: "2027-03-31" },
  insurance_professional_indemnity: { value: "GBP 2m each claim", evidence: "Policy NW-PI-88122", expires_at: "2027-03-31" },
  contract_examples: { value: "3 managed-service contracts 2023-2026, 2 public sector", evidence: "Case study pack, references on request" },
  professional_register: { value: "Registered, company no. 04182233", evidence: "Companies House" },
  health_and_safety_policy: { value: "Policy rev 7, reviewed March 2026", evidence: "Intranet / QMS-07" },
  data_protection: { value: "ICO registration ZA118442, ROPA maintained", evidence: "ICO register" },
  exclusion_grounds_clear: { value: "No convictions", evidence: "Director declarations, March 2026" },
  tax_compliance: { value: "Up to date", evidence: "HMRC statement, March 2026" },
  discretionary_grounds_clear: { value: "None applicable", evidence: "Director declarations, March 2026" },
  // Deliberately the weak spot: the basic scheme, where the tender wants Plus.
  cyber_essentials: { value: "Cyber Essentials (basic) only", evidence: "IASME certificate 2026-04-02", expires_at: "2027-04-02" },
  // Deliberately blank, so the screens show what an unanswered row looks like.
  service_authorisation: { value: "" },
  social_value: { value: "" },
  prompt_payment: { value: "" },
};

async function main() {
  console.log(`seeding ${API}`);

  const tender = await call("/api/tenders", {
    method: "POST",
    body: JSON.stringify({
      name: "Managed IT Support and Network Maintenance 2027-2030",
      buyer: "Coventry City Council",
      reference: "CCC-2026-ITS-041",
      lot: "Lot 1",
      value: "GBP 2.4m over 3 years",
      deadline_at: "2026-10-14",
      clarification_deadline_at: "2026-09-24",
      pack_id: "uk-sq-ppn-0324",
    }),
  });
  console.log(`  tender ${tender.id} (${tender.requirements_added} requirements)`);

  for (const [key, body] of Object.entries(CAPABILITIES)) {
    await call(`/api/capabilities/${key}`, { method: "PUT", body: JSON.stringify(body) });
  }
  console.log(`  profile: ${Object.keys(CAPABILITIES).length} entries`);

  const itt = await upload(tender.id, "ITT-CCC-2026-ITS-041.txt", "itt", ITT);
  const contract = await upload(tender.id, "Conditions-of-contract.txt", "contract", CONTRACT);
  console.log(`  documents: ${itt.page_count + contract.page_count} blocks`);

  const findings = [
    {
      requirement: "economic_minimum", status: "met", document_id: itt.id, page: 1,
      stated: "minimum general yearly turnover of GBP 1,200,000 in each of the last two financial years",
      quote: "Tenderers must demonstrate a minimum general yearly turnover of GBP 1,200,000",
      our_evidence: "GBP 1.84m (FY2025), GBP 1.61m (FY2024)",
    },
    {
      requirement: "accounts_two_years", status: "met", document_id: itt.id, page: 1,
      stated: "audited accounts for the last two financial years, on request",
      quote: "Audited accounts for the last two financial years must be available on request.",
      our_evidence: "Filed to 31 March 2026",
    },
    {
      requirement: "insurance_employers_liability", status: "met", document_id: itt.id, page: 1,
      stated: "employers' liability insurance of not less than GBP 5,000,000",
      quote: "The supplier shall hold employers' liability insurance of not less than",
      our_evidence: "GBP 10m",
    },
    {
      requirement: "insurance_public_liability", status: "met", document_id: itt.id, page: 1,
      stated: "public liability insurance of not less than GBP 5,000,000",
      quote: "public liability insurance of not less than GBP 5,000,000",
      our_evidence: "GBP 10m",
    },
    {
      requirement: "insurance_professional_indemnity", status: "met", document_id: contract.id, page: 1,
      stated: "professional indemnity insurance of not less than GBP 2,000,000 each claim",
      quote: "The Supplier shall maintain professional indemnity insurance of not less",
      our_evidence: "GBP 2m each claim",
    },
    {
      requirement: "contract_examples", status: "met", document_id: itt.id, page: 1,
      stated: "three similar contracts in the last three years, one public sector",
      quote: "Tenderers must provide three examples of contracts of a similar scope and",
      our_evidence: "3 managed-service contracts 2023-2026, 2 public sector",
    },
    {
      requirement: "professional_register", status: "met", document_id: itt.id, page: 1,
      stated: "registration with the appropriate professional or trade register",
      quote: "Tenderers must be registered with the appropriate professional or trade",
      our_evidence: "Registered, company no. 04182233",
    },
    {
      requirement: "data_protection", status: "met", document_id: contract.id, page: 1,
      stated: "process personal data on documented instructions and keep a record of processing",
      quote: "The Supplier shall process personal data only on the documented",
      our_evidence: "ICO registration ZA118442, ROPA maintained",
    },
    // The one that decides it.
    {
      requirement: "cyber_essentials", status: "not_met", document_id: itt.id, page: 1,
      stated: "Cyber Essentials Plus, held at the point of tender submission",
      quote: "Certification to Cyber Essentials Plus is mandatory for this procurement and",
      our_evidence: "Cyber Essentials (basic) only",
      rationale: "The pack rules out the basic scheme explicitly, so this cannot be answered with what we hold.",
    },
    // A bar the pack sets and our profile does not settle.
    {
      requirement: "health_and_safety", status: "unknown", document_id: contract.id, page: 1,
      stated: "a record of processing activities and documented instructions",
      quote: "18.1 The Supplier shall process personal data only on the documented",
      our_evidence: "Policy rev 7, reviewed March 2026",
      rationale: "The pack does not state a health and safety standard; this needs a human read of the specification.",
    },
    // Honestly silent.
    { requirement: "exclusion_convictions", status: "not_stated" },
    { requirement: "exclusion_tax", status: "not_stated" },
    { requirement: "exclusion_discretionary", status: "not_stated" },
    { requirement: "services_authorisation", status: "not_stated" },
    { requirement: "prompt_payment", status: "not_stated" },
  ];

  const result = await call(`/api/tenders/${tender.id}/findings`, {
    method: "POST",
    body: JSON.stringify({ findings }),
  });
  if (result.rejected?.length) {
    for (const r of result.rejected) console.error(`  REJECTED ${r.requirement}: ${r.reason}`);
    throw new Error("a fixture quote is not in its fixture document; fix the seed rather than the check");
  }
  console.log(`  findings: ${result.accepted} accepted, verdict ${result.verdict.verdict}`);

  // A second tender, so the board is a board.
  const second = await call("/api/tenders", {
    method: "POST",
    body: JSON.stringify({
      name: "Grounds Maintenance and Tree Works 2027-2031",
      buyer: "Warwick District Council",
      reference: "WDC-2026-GM-018",
      value: "GBP 900k over 4 years",
      deadline_at: "2026-11-28",
      clarification_deadline_at: "2026-10-30",
      pack_id: "uk-sq-ppn-0324",
    }),
  });
  console.log(`  tender ${second.id} (left unread, so the board shows both states)`);
  console.log(`done. open ${API.replace("8789", "5173")}/tenders`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

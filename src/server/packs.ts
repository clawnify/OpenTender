// The bundled requirement packs.
//
// A pack is one jurisdiction's standard selection questions, turned into rows a
// bid/no-bid can be computed from. They are not invented here: the UK pack is
// the Cabinet Office's own Annex B, with its source URL, publication date and
// licence recorded next to it, because a checklist of legal criteria nobody can
// trace back to a publisher is worse than no checklist.
//
// Applying a pack COPIES its rows onto the tender. From that moment they are
// the user's to edit or delete, and updating the bundle can never change a
// decision that has already been made.

import artifact from "./packs.gen.json";

export interface PackRequirement {
  key: string;
  label: string;
  family: string;
  /** mandatory | scored | optional */
  obligation: string;
  /** Where this row comes from: an Annex reference, or "buyer-specific". */
  source: string;
  hint: string;
  capability_key: string;
}

export interface Pack {
  id: string;
  name: string;
  description: string;
  jurisdiction: string;
  requirements: PackRequirement[];
  provenance: {
    source_url: string;
    document: string;
    publisher: string;
    published: string;
    retrieved: string;
    licence: string;
    note: string;
  };
}

export const PACKS: Pack[] = artifact.packs;

export function findPack(id: string): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

/**
 * The catalogue, without the requirements.
 *
 * Every pack's rows are several thousand words of extraction hints; an agent
 * listing the library to choose one must not receive all of them. It gets the
 * shape here and fetches a single pack on demand.
 */
export function catalogue() {
  return PACKS.map(({ id, name, description, jurisdiction, requirements, provenance }) => ({
    id,
    name,
    description,
    jurisdiction,
    requirement_count: requirements.length,
    mandatory_count: requirements.filter((r) => r.obligation === "mandatory").length,
    publisher: provenance.publisher,
    licence: provenance.licence,
    source_url: provenance.source_url,
  }));
}

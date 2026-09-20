import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, type Capability } from "../api";
import { Button, Card, CardTitle, Chip, Empty, Field, Input, Modal, Toolbar } from "../components/ui";

/**
 * A category here is not the same word as a requirement family.
 *
 * `legal` on a requirement means "the grounds they can exclude you on", and
 * the verdict screen says so. On our own profile the same key means the
 * policies and registrations we hold, so "Exclusion grounds" would label a
 * data protection policy with the thing it protects us from.
 */
const CATEGORIES: Record<string, string> = {
  economic: "Financial",
  technical: "Technical",
  professional: "Professional standing",
  legal: "Legal and regulatory",
  social_value: "Social value",
  other: "Other",
};

const categoryLabel = (key: string) => CATEGORIES[key] ?? key;

/**
 * Our side of every decision, answered once.
 *
 * Turnover and certificates do not change per tender, so they do not live on
 * one. What does change is whether they are still valid on the day: an expiry
 * is a column here, not a note, because the expensive version of this mistake
 * is not a missing certificate — it is one that lapsed in March.
 */
export default function Profile() {
  const [capabilities, setCapabilities] = useState<Capability[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const load = () =>
    api
      .capabilities()
      .then((r) => setCapabilities(r.capabilities))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const blank = capabilities?.filter((c) => !c.value).length ?? 0;

  return (
    <>
      <Toolbar
        title="Our profile"
        subtitle={capabilities ? `${capabilities.length - blank} of ${capabilities.length} answered` : undefined}
      >
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Add entry
        </Button>
      </Toolbar>

      <div className="mx-auto max-w-4xl p-6">
        {error ? <p className="mb-4 text-sm text-danger">{error}</p> : null}

        {capabilities === null ? null : capabilities.length === 0 ? (
          <Empty
            title="Nothing recorded yet"
            hint="Loading a requirement pack onto a tender creates an entry for everything that pack checks, so this page fills itself in as you go."
          />
        ) : (
          <Card>
            <CardTitle count={capabilities.length}>What we can evidence</CardTitle>
            {capabilities.map((cap) => (
              <Entry key={cap.key} cap={cap} onChange={load} />
            ))}
          </Card>
        )}
      </div>

      <AddEntry
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          load();
        }}
      />
    </>
  );
}

function Entry({ cap, onChange }: { cap: Capability; onChange: () => void }) {
  const [value, setValue] = useState(cap.value);
  const [evidence, setEvidence] = useState(cap.evidence);
  const [expires, setExpires] = useState(cap.expires_at);
  const [saving, setSaving] = useState(false);

  const dirty = value !== cap.value || evidence !== cap.evidence || expires !== cap.expires_at;
  const lapsed = expires && expires < new Date().toISOString().slice(0, 10);

  const save = async () => {
    setSaving(true);
    try {
      await api.putCapability(cap.key, {
        label: cap.label,
        category: cap.category,
        value,
        evidence,
        expires_at: expires,
        notes: cap.notes,
      });
      onChange();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-b border-border px-5 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{cap.label}</span>
          <Chip>{categoryLabel(cap.category)}</Chip>
          {lapsed ? <Chip>expired</Chip> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {dirty ? (
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          ) : null}
          <Button variant="ghost" title="Remove" onClick={() => api.deleteCapability(cap.key).then(onChange)}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-[2fr_2fr_1fr]">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="What we hold: GBP 1.8m, held, 3 contracts"
          aria-label={`${cap.label} value`}
        />
        <Input
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="Where to check it"
          aria-label={`${cap.label} evidence`}
        />
        <Input
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          aria-label={`${cap.label} expiry`}
        />
      </div>
    </div>
  );
}

function AddEntry({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("technical");
  const [error, setError] = useState("");

  const submit = async () => {
    const handle = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!handle) return;
    try {
      await api.putCapability(handle, { label: label.trim() || handle, category, value: "" });
      setKey("");
      setLabel("");
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a profile entry"
      description="For something your packs do not already ask about."
    >
      <div className="space-y-3">
        <Field label="Name" >
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ISO 14001" autoFocus />
        </Field>
        <Field
          label="Handle"
          hint="How a requirement points at this entry. Lower case, underscores, like iso_14001"
        >
          <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="iso_14001" />
        </Field>
        <Field label="Category">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-8 w-full rounded-sm bg-surface px-2 text-[0.9375rem] shadow-edge focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {["economic", "technical", "professional", "legal", "social_value", "other"].map((f) => (
              <option key={f} value={f}>
                {categoryLabel(f)}
              </option>
            ))}
          </select>
        </Field>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={!key.trim()}>
            Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}

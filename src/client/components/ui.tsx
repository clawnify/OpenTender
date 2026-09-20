// The shared vocabulary.
//
// Two distinctions do most of the work here, and both are deliberate shapes
// rather than colours: a chip is a fact and a badge is a signal, so a glance
// tells you which you are reading; and a resting edge is an inset ring while a
// floating one is a drop, so a glance tells you what leaves the page.

import type { ReactNode } from "react";

/** A card: an inset ring at 12px, never a painted border and never a drop. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-md bg-surface shadow-edge ${className}`}>{children}</div>;
}

/**
 * The card's title row. Sentence case at 17px, with an optional count riding
 * alongside the subject and an action at the right edge.
 */
export function CardTitle({
  children,
  count,
  action,
}: {
  children: ReactNode;
  count?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
      <h2 className="flex min-w-0 items-baseline gap-2 text-[1.0625rem] font-semibold">
        <span className="truncate">{children}</span>
        {count !== undefined ? <span className="data shrink-0 text-sm text-muted">{count}</span> : null}
      </h2>
      {action ? <div className="flex shrink-0 items-center gap-1.5">{action}</div> : null}
    </div>
  );
}

/** A 48px list row, separated by hairlines inset from the card's edge. */
export function Row({
  children,
  className = "",
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const shell = `flex min-h-12 w-full items-center gap-3 border-t border-border px-5 py-2 text-left ${className}`;
  if (!onClick) return <div className={shell}>{children}</div>;
  return (
    <button type="button" onClick={onClick} className={`${shell} transition-colors hover:bg-sunken`}>
      {children}
    </button>
  );
}

/** Enumerable fact: a document kind, an obligation level, a page number. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-xs bg-sunken px-2 py-0.5 text-xs text-muted">
      {children}
    </span>
  );
}

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

// Tint fill, same-hue text, no border. A bordered badge reads as a control
// someone forgot to make clickable.
const TONES: Record<Tone, string> = {
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
  info: "bg-info-tint text-info",
  neutral: "bg-sunken text-muted",
};

/** Status that demands attention. Medium weight, never bold. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  type = "button",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
}) {
  // shrink-0 + whitespace-nowrap: a button label must never wrap. In a fixed
  // height toolbar a wrapped label does not just look wrong, it overflows the
  // row, and the label is the shortest thing on screen so the space comes from
  // somewhere else.
  const base =
    "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-2 text-[0.9375rem] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50";
  const variants = {
    // Darkens on hover, never lightens. Exactly one of these per screen.
    primary: "bg-primary text-on-primary hover:bg-primary-hover",
    // White with a raised ring rather than a border: at 28px a shadow edge
    // reads crisper than a 1px line.
    secondary: "bg-surface text-foreground shadow-raised hover:bg-sunken",
    ghost: "text-muted hover:bg-sunken hover:text-foreground",
    danger: "bg-danger-tint text-danger hover:bg-danger-solid hover:text-on-primary",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  // The ring is inset, so focus thickens the edge without moving a pixel.
  return (
    <input
      {...props}
      className={`h-8 w-full rounded-sm bg-surface px-3 text-[0.9375rem] text-foreground shadow-edge placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring ${props.className ?? ""}`}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-sm bg-surface px-3 py-2 text-[0.9375rem] text-foreground shadow-edge placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring ${props.className ?? ""}`}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[0.8125rem] font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

/**
 * A stat tile: value first, label under it. Tinted only when the number is
 * itself a status, because a screen where every tile is coloured says nothing.
 */
export function StatTile({
  value,
  label,
  tone = "neutral",
}: {
  value: ReactNode;
  label: string;
  tone?: Tone;
}) {
  const fills: Record<Tone, string> = {
    success: "bg-success-tint",
    warning: "bg-warning-tint",
    danger: "bg-danger-tint",
    info: "bg-info-tint",
    neutral: "bg-surface shadow-edge",
  };
  return (
    <div className={`rounded-md px-3 py-2.5 ${fills[tone]}`}>
      <div className="data text-[1.375rem] font-semibold leading-tight">{value}</div>
      <div className="mt-0.5 text-[0.8125rem] font-medium text-muted">{label}</div>
    </div>
  );
}

/**
 * Never inside a card: an empty bordered box reads as a component that failed
 * to load. The card earns its edge once it has rows to hold.
 */
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-[0.9375rem] text-muted">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-md text-sm text-faint">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Toolbar({
  title,
  subtitle,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    // h-14 matches the sidebar brand row so the two bottom borders form one
    // unbroken line. Never height this from padding: it drifts the moment a
    // page has no subtitle.
    <div className="sticky top-0 z-10 flex h-14 items-center justify-between gap-4 border-b border-border bg-background px-6">
      <div className="min-w-0">
        <h1 className="truncate text-[1.375rem] font-semibold tracking-[-0.01em]">{title}</h1>
        {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * A dialog, for creating a record or confirming a destructive act. The overlay
 * is the scroll container, so a tall form starts at its top and scrolls to the
 * footer instead of clipping both ends.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-foreground/20 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div className="flex min-h-full items-center justify-center">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="w-full max-w-lg rounded-lg bg-surface shadow-float"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-[1.0625rem] font-semibold">{title}</h2>
            {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Slice 6 — plan badge + honest upsell panel (paywall UI).
 * Copy quotes PLANS verbatim so pricing stays single-sourced.
 */
import { useState } from "react";
import { PLANS, tierFor, type Tier } from "~/lib/plans";

export function PlanBadge({ tier }: { tier?: Tier }) {
  const t = tierFor(tier);
  const plan = PLANS.tiers[t];
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-xs font-semibold text-slate-600">
      {plan.label} plan{plan.price !== "$0" ? ` · ${plan.price}` : ""}
    </span>
  );
}

const TIER_ROWS: Array<{ name: string; price: string; items: string }> = [
  { name: "Free", price: "$0", items: "demo area only (Downtown Miami)" },
  { name: "Pro", price: PLANS.tiers.pro.price, items: "owned areas, saved results, PDF reports" },
  { name: "Enterprise", price: "contact", items: "team RBAC, bulk areas, API" },
];

export function UpsellPanel({
  heading,
  body,
}: {
  heading: string;
  body: string;
}) {
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/contact/lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), org: org.trim(), note: note.trim() }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Request failed.");
      }
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
      setSending(false);
    }
  }

  return (
    <div className="card border-brand-200 bg-brand-50/60 p-6">
      <h3 className="text-lg font-bold tracking-tight text-slate-900">{heading}</h3>
      <p className="mt-1 text-sm text-slate-600">{body}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {TIER_ROWS.map((t) => (
          <div key={t.name} className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-sm font-bold text-slate-900">{t.name}</p>
            <p className="text-sm font-semibold text-brand-700">{t.price}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">{t.items}</p>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-slate-500">{PLANS.billingNote}</p>

      <div className="mt-5 border-t border-slate-200 pt-5">
        <p className="text-sm font-semibold text-slate-800">
          Interested in Enterprise? Tell us what you need — we'll follow up.
        </p>
        {sent ? (
          <p className="mt-3 inline-block rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Thanks — we've recorded your request and will be in touch.
          </p>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="mt-3 grid max-w-xl gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="lead-name" className="label">Name *</label>
              <input id="lead-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" disabled={sending} />
            </div>
            <div>
              <label htmlFor="lead-org" className="label">Organisation</label>
              <input id="lead-org" className="input" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Company / agency" disabled={sending} />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="lead-note" className="label">What are you evaluating?</label>
              <textarea id="lead-note" className="input min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="E.g. portfolio of 500 properties across 3 cities" disabled={sending} />
            </div>
            {error && <p className="sm:col-span-2 text-sm text-red-600">{error}</p>}
            <div className="sm:col-span-2">
              <button type="submit" className="btn-primary" disabled={sending}>
                {sending ? "Sending…" : "Send request"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

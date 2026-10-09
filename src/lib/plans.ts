/**
 * Slice 6 — subscription tiers (owner-ratified pricing, 2026-10-06).
 *
 * ALL pricing and tier copy lives in this one config object so amounts and
 * feature text are trivially adjustable. Real billing is BLOCKED until the
 * owner connects Stripe: the gates below are enforced in-app now, but no money
 * moves and nothing implies payments are live (see billingNote).
 *
 * Tiers:
 *   free       $0           — demo area only (Downtown Miami)
 *   pro        $99/month    — owned areas, saved results, PDF reports
 *   enterprise contact      — team RBAC, bulk areas, API
 */

export type Tier = "free" | "pro" | "enterprise";

/** The single price knob for Pro. Change here, everything follows. */
export const PRO_PRICE_MONTHLY = 99;

export const PLANS = {
  proPriceMonthly: PRO_PRICE_MONTHLY,
  proPriceLabel: `$${PRO_PRICE_MONTHLY}/month`,
  /** Honest status note — repeat verbatim anywhere the paywall demos pricing. */
  billingNote:
    "Billing is being connected — saved analyses and reports unlock on Pro when payments go live.",
  tiers: {
    free: {
      label: "Free",
      price: "$0",
      blurb: "Demo area only (Downtown Miami)",
      ownedAreas: false,
      paidAnalyses: false,
      reportDownload: false,
      api: false,
    },
    pro: {
      label: "Pro",
      price: `$${PRO_PRICE_MONTHLY}/month`,
      blurb: "Owned areas, saved results, PDF reports",
      ownedAreas: true,
      paidAnalyses: true,
      reportDownload: true,
      api: false,
    },
    enterprise: {
      label: "Enterprise",
      price: "Contact us",
      blurb: "Team RBAC, bulk areas, API",
      ownedAreas: true,
      paidAnalyses: true,
      reportDownload: true,
      api: true,
    },
  } as const,
} as const;

export type PlanDef = (typeof PLANS.tiers)[Tier];

/** A user's effective tier (missing/unknown = free, the safest default). */
export function tierFor(user: { tier?: Tier } | null | undefined): Tier {
  const tier = user?.tier;
  return tier === "pro" || tier === "enterprise" ? tier : "free";
}

export function canCreateOwnedArea(user: { tier?: Tier } | null | undefined): boolean {
  return PLANS.tiers[tierFor(user)].ownedAreas;
}

export function canRunPaidAnalysis(user: { tier?: Tier } | null | undefined): boolean {
  return PLANS.tiers[tierFor(user)].paidAnalyses;
}

export function canDownloadReport(user: { tier?: Tier } | null | undefined): boolean {
  return PLANS.tiers[tierFor(user)].reportDownload;
}

export function canUseApi(user: { tier?: Tier } | null | undefined): boolean {
  return PLANS.tiers[tierFor(user)].api;
}

/** Honest 403 copy for a gated action — names the Pro price, no urgency. */
export function upsellMessage(action: string): string {
  return (
    `${action} is a Pro feature ($${PRO_PRICE_MONTHLY}/month — owned areas, saved results, ` +
    `PDF reports). ${PLANS.billingNote}`
  );
}
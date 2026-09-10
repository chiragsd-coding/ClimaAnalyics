/**
 * Climate types and the hazard models each one activates. Shared between
 * client and server (no server-only imports here).
 */

export type Hazard =
  | "flood"
  | "cyclone_wind"
  | "extreme_heat"
  | "wildfire"
  | "snow_load"
  | "storm_surge"
  | "drought"
  | "hail";

export const HAZARD_LABELS: Record<Hazard, string> = {
  flood: "Flood",
  cyclone_wind: "Cyclone wind",
  extreme_heat: "Extreme heat",
  wildfire: "Wildfire",
  snow_load: "Snow load",
  storm_surge: "Storm surge",
  drought: "Drought",
  hail: "Hail",
};

export type ClimateTypeDef = {
  value: string;
  label: string;
  blurb: string;
  hazards: Hazard[];
};

export const CLIMATE_TYPES: ClimateTypeDef[] = [
  {
    value: "tropical",
    label: "Tropical",
    blurb: "Hurricane-prone coasts, heavy rainfall, year-round heat.",
    hazards: ["cyclone_wind", "storm_surge", "flood", "extreme_heat"],
  },
  {
    value: "arid",
    label: "Arid",
    blurb: "Hot and dry — heat stress and expanding wildfire zones.",
    hazards: ["extreme_heat", "drought", "wildfire"],
  },
  {
    value: "temperate",
    label: "Temperate",
    blurb: "Mild seasons with rising rainfall extremes and heat waves.",
    hazards: ["flood", "extreme_heat", "hail"],
  },
  {
    value: "continental",
    label: "Continental",
    blurb: "Hot summers, cold winters — snow, storms, and flash floods.",
    hazards: ["flood", "snow_load", "extreme_heat", "hail"],
  },
  {
    value: "mediterranean",
    label: "Mediterranean",
    blurb: "Dry summers driving wildfire risk; autumn flash floods.",
    hazards: ["wildfire", "extreme_heat", "flood"],
  },
  {
    value: "coastal_humid",
    label: "Coastal humid",
    blurb: "Storm surge and cyclone exposure plus chronic flood risk.",
    hazards: ["storm_surge", "cyclone_wind", "flood", "extreme_heat"],
  },
  {
    value: "alpine",
    label: "Alpine",
    blurb: "Heavy snow loads, snowmelt flooding, avalanche-adjacent slopes.",
    hazards: ["snow_load", "flood", "extreme_heat"],
  },
  {
    value: "monsoon",
    label: "Monsoon",
    blurb: "Seasonal deluges and cyclone landfalls dominate losses.",
    hazards: ["flood", "cyclone_wind", "extreme_heat"],
  },
];

export const CLIMATE_VALUES = CLIMATE_TYPES.map((c) => c.value);

export function climateByValue(value: string): ClimateTypeDef | undefined {
  return CLIMATE_TYPES.find((c) => c.value === value);
}

export const RISK_CATEGORIES = [
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
] as const;

export function riskCategoryLabel(category: string): string {
  switch (category) {
    case "very_low":
      return "Very Low";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "very_high":
      return "Very High";
    default:
      return category;
  }
}

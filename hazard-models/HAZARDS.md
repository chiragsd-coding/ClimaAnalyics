# HAZARDS.md — Climate type → applicable hazard dimensions

The engine computes **only** the dimensions listed per climate type below. Each has a one-line rationale. Weights used in the combination rule are in `COMBINATION_RULE.md` and must stay consistent with this file (sets here, weights there).

Resolution rule for users who mislabel a climate type: the score is computed for the **user-selected** type, but the UI must show a warning when the location's climate (Köppen class sampled from the nearest WorldClim tile, see `CREDIBILITY_RISKS.md` §4) disagrees with the selected type.

---

## 1. `tropical` (demo type — Miami)
| Dimension | Rationale |
|---|---|
| `CYCLONE_WIND` | Tropical basins generate recurring major hurricanes/typhoons directly over these coasts. |
| `STORM_SURGE` | Warm SSTs + frequent landfalling cyclones put low-lying coastal structures in the surge zone. |
| `FLOOD` | Cyclone rainfall and monsoon-type rains produce fluvial and surface-water flooding across tropical drainage networks. |
| `EXTREME_HEAT` | Year-round high 2 m temperatures; heat index frequently critical. |
| `WILDFIRE` | Seasonal dryness (dry season / El Niño) enables fire, especially savanna–urban interface zones; weight is small. |
| *(not applied)* | Snow load, drought, landslide — snow never; drought/landslide are not first-order structural hazards for typical tropical urban areas in the MVP. |

## 2. `arid`
| Dimension | Rationale |
|---|---|
| `EXTREME_HEAT` | The defining hazard: extreme summer maxima and long hot spells directly stress structures and occupants. |
| `DROUGHT` | Chronic multi-year water deficit defines the regime; drives wildfire fuel dryness and soil/foundation stress. |
| `WILDFIRE` | Dry fuels and strong winds (desert fringes, scrub) support fire; urban–wildland interface is common. |
| `FLOOD` | Flash-flood and wadi/arroyo flooding after rare intense rain is a documented structural killer even in deserts — keep, but often scored low. |
| *(not applied)* | Snow load (rare/coastal margin — treated by temperate/continental selection instead), storm surge, cyclone wind (outside the rare Arabian Sea/Caribbean fringe — see climate warning), landslide. |

## 3. `temperate`
| Dimension | Rationale |
|---|---|
| `FLOOD` | River and surface-water flooding is the most frequent structural hazard in temperate maritime/mixed zones. |
| `WILDFIRE` | Continental-temperature zones (e.g., interior North America, southern Europe fringe) burn cyclically. |
| `EXTREME_HEAT` | Heat waves are the region's most deadly climate hazard in recent decades (e.g., 2003/2019 European events). |
| `SNOW_LOAD` | Cold-season snowfall reaches structural design relevance in northern temperate latitudes. |
| `LANDSLIDE` | Temperate hillside zones (Appalachian, central European low mountains) have documented slope failures after wet periods. |
| *(not applied)* | Cyclone wind (extra-tropical systems exist but the `CYCLONE_WIND` model is tropical-only), storm surge, drought (subsumed under wildfire/heat weights). |

## 4. `continental`
| Dimension | Rationale |
|---|---|
| `SNOW_LOAD` | Interior-latitude winters produce deep snow packs; design snow loads are a standard structural consideration here. |
| `EXTREME_HEAT` | Continental interiors show the widest seasonal swings; summer maxima are real heat hazards. |
| `WILDFIRE` | Boreal/forest and grassland fire regimes (Canada, Russia, US plains) are structurally relevant. |
| `FLOOD` | Spring melt + convective rain drive river flooding on continental basins. |
| *(not applied)* | Cyclone wind, storm surge (coast fringe handled by coastal types), drought (second-order: captured via wildfire), landslide (mostly low-relief interiors; hilly sub-zones should pick temperate or alpine). |

## 5. `mediterranean`
| Dimension | Rationale |
|---|---|
| `WILDFIRE` | The canonical fire-climate regime: hot dry summers + dry fuels + wind events; urban–wildland interface is extreme (California, Greece, Iberia, Australia). |
| `EXTREME_HEAT` | Summer heat is severe and frequent. |
| `FLOOD` | Autumn/winter convective rainfall on steep catchments produces flash floods (Valencia 2024-type events). |
| `DROUGHT` | Multi-year droughts are regime-defining and pre-condition fire. |
| *(not applied)* | Snow load (mountains within the climate type exist but should be scored as alpine), storm surge (not a first-order structural risk for MVP; revisit), cyclone wind (rare; e.g., medicanes — explicitly out of MVP scope), landslide (hillsides do fail; excluded in MVP to keep the model small — revisit if a customer region demands it). |

## 6. `coastal-humid`
| Dimension | Rationale |
|---|---|
| `CYCLONE_WIND` | Humid-subtropical coasts (Gulf of Mexico, East Asia, Brazil) sit in tropical-cyclone corridors. |
| `STORM_SURGE` | Low-lying coastal development is exposed to surge; the defining differentiator of this type versus plain temperate. |
| `FLOOD` | Persistent heavy rainfall + flat coastal catchments flood readily. |
| `EXTREME_HEAT` | High temperature plus high humidity → dangerous heat index (wet-bulb stress). |
| *(not applied)* | Snow load (rarely design-relevant), wildfire (localised, e.g., SE US coastal fires — excluded for MVP), drought, landslide. |

## 7. `alpine`
| Dimension | Rationale |
|---|---|
| `SNOW_LOAD` | Mountain winters produce the highest snow packs on the continent; design snow load is a primary structural consideration. |
| `LANDSLIDE` | Steep valley slopes + melt/rain triggers are the classic alpine structural hazard (slides, debris flows). |
| `WILDFIRE` | Drier mountain slopes below treeline burn (western US/CAN, Pyrenees, Alps fringe). |
| `FLOOD` | Snowmelt + valley flash floods affect valley-floor towns. |
| *(not applied)* | Cyclone wind, storm surge, drought, extreme heat (altitude moderates heat; present but not first-order for MVP). |

## 8. `monsoon`
| Dimension | Rationale |
|---|---|
| `FLOOD` | The defining hazard: seasonal deluge floods river basins and urban storm drains (South/Southeast Asia). |
| `CYCLONE_WIND` | Bay of Bengal / South China Sea / Philippines cyclones strike monsoon regions repeatedly. |
| `EXTREME_HEAT` | Pre-monsoon heat is among the world's most severe (South Asia); wet-bulb extremes occur. |
| `LANDSLIDE` | Monsoon rain on Himalayan/Southeast-Asian hill slopes drives landslides and debris flows into settlements. |
| `DROUGHT` | Monsoon failure years produce severe drought; included at modest weight. |
| *(not applied)* | Snow load (Himalayan high terrain should be scored as alpine), storm surge (locally important — cyclones do surge — but covered by cyclone+flood weights in MVP; flagged in `OPEN_QUESTIONS.md`), wildfire (dry-season fires exist; weight folded into drought). |

---

## Summary table

| Climate type | FLOOD | CYCLONE_WIND | EXTREME_HEAT | WILDFIRE | SNOW_LOAD | STORM_SURGE | DROUGHT | LANDSLIDE |
|---|---|---|---|---|---|---|---|---|
| tropical | ✔ | ✔ | ✔ | ✔ | — | ✔ | — | — |
| arid | ✔ | — | ✔ | ✔ | — | — | ✔ | — |
| temperate | ✔ | — | ✔ | ✔ | ✔ | — | — | ✔ |
| continental | ✔ | — | ✔ | ✔ | ✔ | — | — | — |
| mediterranean | ✔ | — | ✔ | ✔ | — | — | ✔ | — |
| coastal-humid | ✔ | ✔ | ✔ | — | — | ✔ | — | — |
| alpine | ✔ | — | — | ✔ | ✔ | — | — | ✔ |
| monsoon | ✔ | ✔ | ✔ | — | — | — | ✔ | ✔ |

*(— means the dimension is never computed for that type in the MVP.)*

**Wildfire is deliberately present in alpine/tropical/arid at small weights** — it is real there, but the user-visible "dominant hazard" logic (COMBINATION_RULE.md §4) keeps the headline honest.
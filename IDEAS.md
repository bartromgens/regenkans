# Ideas

Backlog of feature ideas and improvements. Check off items when implemented.

## UI / UX

- [x] Add a favicon
- [x] Rename the 'intensiteit' toggle to make it more descriptive
- [x] Rename the 'verwacht' toggle to make it more descriptive
- [x] Add an information icon next to the toggle that explains the different modes
- [ ] Improve the plot position and layout on desktop (larger and not on top of the slider)

## Timeline / Map

- [x] Reduce the timeline slider history to 6 hours by default
- [ ] Advanced 'history' page that allows users to select any date available in our database, and shows the full 24 hour in a slider
- [x] Add a play button that animates the map timeline
- [ ] Show individual ensemble member forecasts (spaghetti plot / step-through) at a clicked point, instead of only the aggregated probability — the per-member data is already read from the NetCDF file, just currently discarded after being collapsed into the % probability

## Mobile

- [x] Create a dedicated/optimized mobile version with two pages 'map' and 'chart' (as tabs on the top), and a slider that always works

## Pages

- [x] Add an 'about' page that explains the project, data sources, method and contact info (info@regenkans.nl)
- [ ] Public API docs page: document a read-only endpoint for the processed data (not just raw KNMI files) so other devs/hobbyists can build on top of regenkans
- [ ] Historical extremes page (e.g. "heaviest rain this month/year"), built from already-stored data

## Performance

- [ ] Improve the load performance of both map and chart
  - [ ] Pre-load prediction map data when the user opens the app, so data is ready when the user starts dragging the slider
  - [ ] Pre-render the tiles when a new prediction/ensemble is ingested

## Data ingestion

- [ ] Subscribe to the KNMI Open Data MQTT stream to get notified of new radar/ensemble files as they're published, instead of polling on a cron schedule (currently every 5/6 min) — reduces ingestion latency and unnecessary requests
- [ ] Ingestion health dashboard for signed-in users: recent ingestion runs, failures, and file lag — ops-facing, distinct from the user-facing data freshness indicator (needs user accounts/auth, which don't exist yet)

## Personalization & alerts

- [ ] "Rain in X minutes" countdown for the user's current/saved location — the simplest possible answer to the app's core question
- [ ] Save favorite locations (e.g. home, work) for quick switching
- [ ] Push notification (PWA) when rain is likely to start soon at a saved location
- [ ] Installable PWA with offline fallback showing the last cached radar frame

## Trust & transparency

- [ ] Forecast verification page: track how probability predictions compared to what radar actually observed afterwards, as a measure of forecast skill over time
  - [ ] Backend: persist forecasts (per-member or aggregate) at issue time, join against later radar observations for the same time/place, and compute a skill metric (e.g. Brier score) — needed to power the verification page above
- [ ] Data freshness indicator (e.g. "radar updated 3 min ago") so users notice if ingestion has stalled, rather than silently viewing stale data
- [ ] Ensemble spread indicator: show member disagreement (e.g. std dev across the 20 members) as a layer alongside intensity/probability, so low spread reads as "confident" and high spread as "uncertain"
  - [ ] Stretch: divergence-rate ("chaos") indicator — track how fast spread grows with lead time, to distinguish forecasts that are uncertain from the start vs. ones that start tight and blow apart

## Sharing

- [ ] Shareable deep link to a specific location + time, with a preview image (for "rain's coming in 20 min, look")
- [ ] Downloadable/shareable short animation (GIF) of the last hour of rain for a chosen area

## Accessibility & reach

- [ ] Dark mode
- [ ] English/Dutch language toggle
- [x] Keyboard-navigable timeline slider (native via Angular Material; added an accessible name/aria-label on the slider and play button)
- [ ] Screen-reader labels for the remaining map controls (zoom, geolocate, mode toggle)

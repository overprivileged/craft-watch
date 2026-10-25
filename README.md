# Craft Watch

A free, static website that watches the **public** GitHub activity of the ArtCraft apps and shows it as a live map,
with plain-English safety help. Made by Overprivileged.

**Public data only · signals, not a guarantee · it flags, it never accuses.**

Beta · unofficial · not affiliated with ArtCraft/storytold.

## This fork

This is a customized fork of [overprivileged/craft-watch](https://github.com/overprivileged/craft-watch), preserving the original project's attribution and history. It adds a configurable activity explorer with per-app comparisons, event sampling, replay and drag-to-zoom controls, adjustable symbols and PR connectors, an adaptive timeline, and midnight PST guides.

This fork is shared as source code for local use. GitHub Pages is disabled; no website is deployed from this repository. Follow **Local preview** below to run it on your computer.

## Status

The site is a static HTML/CSS/JavaScript activity explorer. Choose any combination of apps, replay recorded activity, and follow PR lifetimes, commits, and published releases.

## Layout

- `repos.json`: the apps we watch (name, repo, colour, official download page).
- `scripts/`: the data collector (phase 2).
- `data/`: collected data; `data/history/` holds one small file per day.
- `site/`: the static site (phase 4 onward).
- `SPEC.md`, `CLAUDE.md`, `design/`: the build spec, the rules for building it, and the look.

## Data sources

Only public GitHub data: commits, pull requests, issues, releases, security advisories, and public dependency
vulnerability feeds. No accounts, no cookies, no analytics, no tracking.

## Local preview

Requires Node.js 20 or newer. No dependencies or build step are needed.

```sh
cd craft-watch
npm run data:preview  # download the upstream site's public data snapshot
npm run dev           # open http://localhost:4321 in your browser
```

Leave the terminal running while viewing the site. Save an HTML, CSS, or JavaScript change and refresh the browser to see it. Stop the server with Ctrl+C. Opening `site/index.html` directly as a file will not load the data correctly.

Run `npm run data:preview` again to update your local snapshot. The page rereads the local snapshot every five minutes; a replay stays anchored to its starting snapshot. To collect your own data directly from GitHub, set `GITHUB_TOKEN` in your environment and run `npm run collect` instead.

## Activity explorer

- The app dropdown supports individual checkboxes, search, Main 8, All, and Clear. The URL and browser-local preferences preserve the selection.
- “Show on map” independently toggles arcs, commits, releases, open PRs, PRs created, open issues, merged PRs, and PRs closed without merging. Layer choices persist locally and in the URL. Toggles affect the map and legend; summary counters remain visible. Open-item markers follow replay time and default to 20 recent recorded items per app and type, with configurable limits or probability sampling. Historical states are approximate because reopen transitions are unavailable.
- “Display limits” gives every layer (arcs/connectors, commits, releases, PR open, PR created, issue open, PR merged, and PR closed unmerged) a Count / Probability switch. Count keeps the newest eligible items per app, with an Unlimited checkbox. Probability uses a 0–100% slider or numeric field: 50% is a 0.5 independent chance per item, not an exact half. Each layer has its own Resample button. Valid edits apply immediately; slider drags apply on release. The replay clock, summary counts, and layer visibility stay unchanged. Reset defaults restores count limits; Everything unlimited removes all caps and probability filtering. Version-label preferences are preserved. Unlimited and 100% include all loaded eligible records, not missing history.
- Latest offers 1h, 8h, 1d, 3d, 7d, 14d, and 30d ranges ending at the latest snapshot. The range updates the map and activity counts, uses a linear time scale, and is saved locally and in the URL (`range=8h`, for example). Open PR totals remain the latest snapshot totals. Choosing a range exits replay; returning to Latest keeps that range. Replays cover an hour, a day, or 30 days, with pause, restart, and a scrubber. A replay stops at the end. Reduced-motion preferences start replays paused.
- PR arcs grow from creation to the displayed time, then become green when merged or grey when closed without merging. The default map displays up to 10 recently active PRs per app; counters include all collected records.
- By default, dots are default-branch commits, hollow amber circles are currently open PRs, blue triangles are PR creation events, green diamonds are merges, grey crosses are unmerged closures, and gold stars are published releases. Hover for details; PRs and releases link to GitHub.
- Historical open PR counts are estimates based on the latest open count and recorded transitions. Reopen history is unavailable. Commit timestamps can be partial in an upstream preview snapshot or when full collection fails. The collector now paginates the complete 30-day commit history. `npm run data:commits` enriches an existing local snapshot using `GITHUB_TOKEN`; it must be rerun after a preview download replaces that snapshot. Neither a commit nor a merge proves that code is included in a release.

```sh
npm test              # replay accounting and data-boundary checks
```

`npm run collect` requires a `GITHUB_TOKEN` for GitHub GraphQL. The token is read from the environment only and is never stored. The public preview download needs no token.

- Map layers include independent merged PR and closed-without-merging markers at their resolution timestamps. These do not depend on arcs; each has its own per-app display cap (100 by default, or Unlimited).
- The unified Show on map panel places each visibility checkbox beside its symbol controls. It controls each event's shape, size, and placement above/on/below the lane. Arcs have placement and thickness controls. Settings apply immediately, preserve the replay position, and persist locally and in the `appearance` URL parameter. Reset appearance restores the defaults.

- Lanes originate at the ArtCraft core, with their first third left empty. The full selected time range, event markers, arc endpoints, axis ticks, and replay playhead occupy the remaining two thirds.

- Arcs offer lifetime curves or straight opening-to-merge connectors with separate thickness. Connectors require PR created and PR merged layers and join the actual visible endpoints for the same PR. Both events must be within the selected range and their respective display caps. They appear only after the merge is reached in replay. PR open remains an independent layer of currently open PRs.
- Probability samples stay stable through replay, zoom, restyling, and reloads. Sampling happens before time-window filtering, using repository and event identity (timestamp plus occurrence for timestamp-only commits). A separate seed per layer makes Resample independent. Connector lines also require both their sampled opening and merge markers to be visible. Settings persist locally and in the URL’s filters parameter; older arc_filter, arc_probability, and arc_seed links remain supported.

- PR created marks creation events, including PRs subsequently merged or closed. It has its own shape, position, size and display limit. PR open represents the state at the displayed time and disappears when a PR resolves.

- Opening-to-merge connectors support Straight or Follow lane / S-curve, with bend strength 0–3. Follow lane interpolates each endpoint’s offset relative to the curved lane; equally spaced opposite-side markers cross at the temporal midpoint. Endpoint positions and times stay unchanged between connector styles.

- Drag horizontally anywhere on the SVG map to select and zoom into an interval. The selection guide stays at the starting vertical position; only x coordinates determine time. Either drag direction works. Six pixels of horizontal movement distinguishes dragging from a link click, and intervals shorter than one second are ignored. Escape cancels. A zoom pauses replay and shows a static historical interval; counts are calculated at its endpoint. Reset zoom returns to the chosen Latest range. Zoom bounds are saved in the URL and preserve the snapshot while inspecting. Motion respects reduced-motion preferences.

- Combined totals and the per-app table follow the selected range, zoom, and replay time, independently of map display limits.
- The timeline fits app names against the right edge and grows taller as more apps are selected. The legend sits in its upper-left corner. Selection dates appear in the fixed map header during a drag.
- Faint vertical guides mark daily midnight in fixed PST (UTC−8). They follow the displayed interval and full map height.

- While dragging a time selection, the per-app table previews counts inside that interval and marks itself “Drag preview.” Open PRs remain an estimated backlog at the selection’s endpoint. Release commits the zoom; Escape or a cancelled drag restores the prior counts. Indexed timestamp lookups keep preview updates light even with many apps.

# #127 · Verification of #120 artifacts (PR #7, feat/artifacts @ ad3cb59)

Verdict: **the feature works; one blocker for merging: PR #7 now conflicts with main.** Details below.

## Blocker
- `git merge-tree origin/main origin/feat/artifacts` (18 Nov 2026, after PRs #8/#11/#12 and the #139 rows) reports content conflicts in `packages/engine/src/runner.ts`, `packages/ui/src/App.tsx`, `Board.tsx`, `CardView.tsx`, `api.ts`, `styles.css`, `scripts/ui-check/check.mjs` and an add/add in `typeRules.test.ts`. munih must merge main into the branch again and re-run typecheck, npm test and ui-check. My checks were done on the PR head as it is.

## Passed
| Area | How | Result |
|---|---|---|
| Typecheck, unit tests | `npm run typecheck`; `npm test` x4 | clean; 555/555 on 3 of 4 runs (1 failure on the first run, none on the next three: known flake, m101) |
| Migration 0041 on a copy of the real DB | backup of atlas.db + workspaces, `ATLAS_DATA_DIR=/tmp/q7 ATLAS_PORT=4399 tsx main.ts` | log « converted 45 canvas(es) to artifacts »; documents 104 → 104 (59 original + 45 converted, 0 whiteboards left); 45 html pages in folder « Canvases », all 45 files exist (atlas 37, munih 4, paris 4); row counts of every other table identical (cards, messages, runs, tool_calls, memories, ...; runs/schedules changed only because my copy let the engine start old todo cards and seed the default schedule); restarting the engine does not convert again (45, 1 folder) |
| Chat card | e2e (new) | `Document · v1 · v3 is the latest`, `Updated to v2 · Document · v3 is the latest`, `Updated to v3 · Document`; page / diagram / link kinds; a card opens its own version (`v1 of 3`, `v2 of 3`) |
| Viewer | e2e (new) | ONE `.sd-head`; `vN of M` button has class `old` (warn colours); Latest; version picker lists versions and `Restore v1 as v4` creates v4; ⋯ (chat) = author, folder, path, source, Open in the Library, Open in the browser for links only; Full size toggles `.full`; ≤760 px: full screen + ‹ Back, 761 px: side panel without Back |
| Library | e2e (new) + screenshots | folder counts; type tabs All/Docs/Pages/Diagrams/Links; 4 live tiles (rendered content, swipe row at 390: scrollWidth > clientWidth, no page overflow); Pinned group; row ⋯ (Open / Pin / Move to); Move to updates counts; New folder; rename; delete → items to Unfiled, total unchanged; search by content with snippet + folder badge; empty state; Library viewer ⋯ = Pin + Move to; phone: folders are chips with ⋯ |
| Contrast | e2e computes colour vs background | every checked text ≥ 4.5:1 in dark and light (lowest: `.count` 4.78 dark, `.lib-when` 5.12; `.art-meta` 6.28 / 6.81) |
| ui-check | `check.mjs --ui packages/ui/dist` on the migrated copy, 1440 + 390, dark and light | 92 screens each, 497 labels OCR'd: no issues (incl. library-search, library-search-empty, library-doc-versions) |
| Whole e2e suite | `npx playwright test` | 81/81 (70 existing + 11 new in `e2e/tests/artifacts.spec.ts`) |
| Real data, UI | screenshots in the migrated copy | Library shows All artifacts 104 / Unfiled 59 / Canvases 45; a converted canvas opens as a page in the viewer; old links `#/canvas/x` → Library, `#/doc/<id>` → viewer; no page errors |

## Observations (not blocking, for munih / Master to judge)
1. **Canvas history is not carried over.** The 45 canvases had 174 saved versions; each artifact starts at v1 with the latest content. The old `canvases` and `canvas_versions` tables stay in the DB (nothing is lost, but nothing reads them). Say so in the changelog entry if not already.
2. **Old chats**: past `canvas_create/write/read` calls render as plain tool rows (« Created canvas … cv_7e8c3822 ») with no chip and no link to the converted page. Readable, but the canvas ids are dead ends.
3. On a phone the side panel opens full screen on loading a chat whose panel was open; ‹ Back reveals the chat. Consistent with the spec (≤760 px = full screen), but a user who reloads sees the panel first.
4. On the phone the folder chips' ⋯ sits at the end of the scrolling row; a scroll closes an open menu (normal for this menu component).

## Tests added
`e2e/tests/artifacts.spec.ts` (11 tests): chat cards, versions/restore/⋯ menu, kinds, phone panel, Full size, Library (folders, tabs, tiles, search), pin/move/rename/delete, Library viewer, phone Library, contrast in both themes. Run: `npm run build`, then in `e2e/`: `E2E_CHANNEL=chrome npx playwright test artifacts`.

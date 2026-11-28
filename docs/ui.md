# UI: type rules, ui-check, screenshot tool

Moved out of `CLAUDE.md` (#295) so it is read when needed, not sent with every model request. CLAUDE.md points here.

## UI type rules
Same scale as OpenCode (packages/ui/src/styles/theme.css). Enforced by `packages/ui/src/typeRules.test.ts` and ui-check.
- **Tokens** (styles.css, the « type tokens » block): sizes `--fs-small` 13, `--fs-base` 14, `--fs-large` 16, `--fs-xl` 20 px;
  weights `--fw-regular` 440, `--fw-medium` 530, `--fw-bold` 670; line heights `--lh-tight` 130% (one-line labels),
  `--lh-normal` 150%, `--lh-long` 180% (chat messages, descriptions, documents). Families: `--font`, `--mono`.
  Mono text uses the same size tokens.
- **No literal** font-family, font-size, font-weight or line-height in CSS or in inline styles: always a token. Need a
  fifth size? Ask first, don't add one.
- **No text under 13 px.** Allowed exceptions, each marked `/* type-exception: why */` on its line: inputs at 16 px on
  phone (iOS zooms in below 16), and a letter inside a tile too small for 13 px (aria-hidden).
- **Contrast:** text colours that carry information reach 4.5:1 on `--app`, `--panel` and `--raised` in both themes
  (`--faint` is the floor). Placeholders and disabled text may be lower.
- **@font-face** only through the fontsource imports in `main.tsx`.

## Tags, controls, spacing (#402)
- **Tag** (`.tag`, also `.badge` and `.proj-tag`): anything only read (project, #ref, count, type, state) is 22 px,
  `--chip` fill, no border; `.tag.mono` for a repo or a ref. `.st-chip` and `.badge.ok|bad|warn` keep their state colours.
- **Control**: anything clicked is bordered, 28 px in a bar or a row (`.btn`, `.btn.small`, `.tabbtn`), 32 px in a form's
  button row. « New X » is one `.btn.primary` in the screen's header, never a second « + New » tile under a list.
- **Radius**: `var(--radius-*)` (all 0), never a literal; only the app icon tile is rounded.
- **Spacing**: `--s1…--s4` (4/8/12/16 px). Bars, rows and heads start their text 16 px in. Move a rule to the tokens when
  you touch it, file by file.

## Responsive check (ui-check)
**Responsive check** (`scripts/ui-check/check.mjs`, macOS: needs Xcode's `swiftc` for the OCR). Opens the built UI
(`packages/ui/dist`: `npm run build` first) on its own throwaway engine, in headless Chromium, at 1440 / 1100 / 900 / 390 px (390 = phone, touch) on every main screen: chat with
pins, ticket modal, side panel, board, inbox, Library (list with tiles, search, a doc, its version picker), workflows (list, canvas edit, canvas runs, off), every settings page. It reports page-wide horizontal overflow (and
the phone zoom-out it causes), text under 12px, text off-screen outside a scroller, pins or chat buttons covering
messages or the composer, the modal or panel off-screen, uncaught page errors, and key labels that Apple Vision OCR
(`ocr.swift`) can't read at confidence ≥ 0.5. Exit code 1 on any issue; screenshots + `report.json` in
`$TMPDIR/atlas-ui-check` (`--out DIR`).
- Beyond layout it also fails on: an error banner the page raised (`.error[role=alert]`, e.g. « task … not found »: a
  fixture the harness forgot to serve), and two text boxes of the same header overlapping (« All tasks » tab over the
  « Tasks » title, #224). Fixture tasks (`c_uicheck…`) are served in full (task, messages, runs, timeline, usage); a
  fixture page that opens an update in the Inbox gets a fake 204 for « mark read » (listed under refused writes).
- **It runs inside the agent sandbox** (#314). The browser is Playwright's `chrome-headless-shell --no-sandbox`
  (`scripts/ui-check/tooling.mjs` finds it in `~/Library/Caches/ms-playwright` and installs it once when missing;
  `ATLAS_CHROME=<binary>` overrides, e.g. Chrome.app on Master's Mac). The engine is `scripts/ui-check/engine.ts`: a real
  engine (no dispatch, no model, no GitHub) on a seeded database in `$TMPDIR`, removed when the run ends. `--port N`
  checks an engine you started instead (outside the sandbox: a copy of the live data on Master's Mac).
- **Seeded vs live data.** The seed has 4 agents, one chat of ~30 mixed messages (prose, list, table, code, a long unbroken
  word), 9 tasks in every column (short and very long titles, one long brief), 5 documents (markdown, html, diagram, link,
  one in a folder), 4 memories. What it lacks against the live app: hundreds of tasks and chats, real long titles and
  messages, other projects (ui-check adds its own « Datinel » fixture), real model names and plan accounts, schedules and
  workflows' history. So a screen's overflow with a very long real title, or a list that scrolls only at 300 rows, can
  pass here and fail live. The seed's own fixtures and every check are the same in both; ask Master for a run with
  `--port` on live data when the change depends on volume.
- **OCR inside the sandbox.** Apple Vision writes a cache under the real `~/Library/Caches`, which the sandbox denies (it
  dies with « Fatal error … nilError »). ui-check starts the OCR with `CFFIXED_USER_HOME=$HOME`, so the cache goes to the
  shell's own home (the workspace in the sandbox); no extra access, and the label check runs there like anywhere. If you
  run `scripts/ui-check/ocr.swift` or your own Vision script in the sandbox, set the same variable.
- Read-only: the harness refuses every API write from the page. Pins and the panel come from fixtures added to the
  responses the page sees (4 cards in every pin state, a real document in a panel tab); nothing is stored.
- `--ui DIR` serves another build than `packages/ui/dist` (with `--port`: a proxy in front of that engine).
- `--widths 390`, `--only chat,modal` (screen-name prefixes) to narrow a run; a full run takes ~75 s on a quiet Mac (several minutes while other agents run checks).
- Run it after any UI layout change; the acceptance bar is « no issues » at all widths. **Run only what the change can
  affect** (#240, Master: « tasks in side panel doesn't need 260 screens »):
  - Engine-only or docs-only change: no ui-check.
  - UI change: `--only` on the screens that render the changed components, plus the ones the builder lists, at all four
    widths. `--only` matches screen-name **prefixes**: `chat` (all `chat-*`), `task` (task-board, -list, -inbox, -chat,
    -images, -blocked), `thread` (thread, thread-images), `new-task` (new-task-images, new-task-2), `panel` (panel,
    panel-max, panel-sees, panel-files, panel-files-search: the Files editor and its search bar), `drawer`, `board`, `inbox`, `library`, `project` (projects-2, project-page, project-new: **not** covered
    by `settings-`, though they live under `#/settings/projects`), `settings-` (the 12 settings pages, memory and secrets
    included; or `settings-memory`, `settings-secrets`…), `workflow` (list, edit, runs, off, workflows-2), `palette`,
    `shortcuts`. The `-2` screens (board-2, drawer-2, inbox-2, workflows-2…) are the second-project fixtures (#217) and
    follow their prefix. The names: the `SCREENS` array and the `SETTINGS` list in `scripts/ui-check/check.mjs`; check a
    prefix matches something before trusting a run (`--only` with no match checks nothing).
  - **Full run** (no `--only`) only when the change touches something every screen shares: global styles (`styles.css`
    tokens and resets), the app shell or sidebar, shared headers, the side panel shell, fonts
    (`main.tsx` imports), or `scripts/ui-check` itself.
  - **One ui-check at a time of yours.** Two at once on a busy Mac give false failures (layout width, « never showed ») from
    timing. Each run has its own engine, browser profile and `$TMPDIR`, so runs of different agents do not collide, but
    in the sandbox you cannot see them (`pgrep`/`ps` are refused, #322): don't try. If a screen fails that your change
    cannot affect, rerun it alone (`--only <screen> --widths <w>`) before believing it. Before a second run of your own, read
    the first with `shell_output` (or `shell_kill` it).


## Screenshot tool
**Screenshot tool** (#133, `packages/engine/src/screenshot.ts`): agents have a built-in `screenshot` tool, one picture
of a route (`#/board`) or a workspace page (`pages/x.html`, `/api/files/<agent>/…`) at a width/height and theme, with
optional `clip`, `full_page`, `wait_for` and `actions` (click, type, press). It runs in the engine, outside the sandbox
(it keeps using Chrome.app; `ATLAS_CHROME` overrides), a fresh headless Chrome against the engine it runs in (no port lookup), refuses every write from the page (the main-chat lookup gets a read-only answer),
fails after 15 s naming what never appeared, and returns page errors + refused writes with the picture (saved under
`screenshots/`). Unit tests: `screenshot.test.ts` (fast); real Chrome: `test/screenshot.chrome.test.ts` (slow project).

## UI how-tos
- Styles are global: a class named after data (`card`, `board`, `panel`) collides with the board's CSS. Prefix dynamic
  class names (`rowic-<name>`) and update the selectors in `scripts/ui-check` when renaming.
- The task view is `packages/ui/src/CardView.tsx`, shared by `CardModal.tsx` and `ThreadPanel.tsx`: edit it for both.
- `ui-check` tests the built UI (`npm run build` first: a stale `packages/ui/dist` gives false errors) and needs
  `npm ci` once in the clone ("Cannot find package 'sharp'" otherwise). Several runs at once give false failures
  (layout width, "never showed .settings"): rerun the failing screens alone with `--only` and `--widths` (the machine is
  busy; the sandbox cannot show who else runs one, see « One ui-check at a time »). A label whose text Vision did not read on the page (nothing in its box, or only its neighbours: a row's chevron or time, #343) is read again on crops of its box with margins of 24, 8, 0 and 60 px (#328: Vision sometimes drops a line from one crop and reads it from the next); only a label still unread after all four fails. The matching is `scripts/ui-check/ocrmatch.mjs` (tested). The OCR reading "All" as "AIl" or "Links" as "LInks" is a known quirk: the
  comparison folds `i`, `I` and `l` into one letter (nothing else is forgiven).
- An HTML mockup in the side panel gets the panel's width, so a page with a 640 px breakpoint shows its phone layout
  there: judge the desktop layout full size (`/api/files/<agent>/pages/<file>.html`).

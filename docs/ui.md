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

## Responsive check (ui-check)
**Responsive check** (`scripts/ui-check/check.mjs`, macOS: needs Google Chrome and Xcode's `swiftc`). Opens the running
Atlas app's UI in headless Chrome at 1440 / 1100 / 900 / 390 px (390 = phone, touch) on every main screen: chat with
pins, ticket modal, side panel, board, inbox, Library (list with tiles, search, a doc, its version picker), workflows (list, canvas edit, canvas runs, off), every settings page. It reports page-wide horizontal overflow (and
the phone zoom-out it causes), text under 12px, text off-screen outside a scroller, pins or chat buttons covering
messages or the composer, the modal or panel off-screen, uncaught page errors, and key labels that Apple Vision OCR
(`ocr.swift`) can't read at confidence ≥ 0.5. Exit code 1 on any issue; screenshots + `report.json` in
`/tmp/…/atlas-ui-check` (`--out DIR`).
- Beyond layout it also fails on: an error banner the page raised (`.error[role=alert]`, e.g. « task … not found »: a
  fixture the harness forgot to serve), and two text boxes of the same header overlapping (« All tasks » tab over the
  « Tasks » title, #224). Fixture tasks (`c_uicheck…`) are served in full (task, messages, runs, timeline, usage); a
  fixture page that opens an update in the Inbox gets a fake 204 for « mark read » (listed under refused writes).
- The engine port is read from the running app (`lsof`; it changes on every start), or `--port N`.
- Read-only: the harness refuses every API write from the page. Pins and the panel come from fixtures added to the
  responses the page sees (4 cards in every pin state, a real document in a panel tab); nothing is stored.
- `--ui packages/ui/dist` tests a local build (`npm -w @atlas/ui run build`) against the same engine, before reinstalling.
- `--widths 390`, `--only chat,modal` (screen-name prefixes) to narrow a run; a full run takes ~75 s.
- Run it after any UI layout change; the acceptance bar is « no issues » at all widths. **Run only what the change can
  affect** (#240, Master: « tasks in side panel doesn't need 260 screens »):
  - Engine-only or docs-only change: no ui-check.
  - UI change: `--only` on the screens that render the changed components, plus the ones the builder lists, at all four
    widths. `--only` matches screen-name **prefixes**: `chat` (all `chat-*`), `task` (task-board, -list, -inbox, -chat,
    -images, -blocked), `thread` (thread, thread-images), `new-task` (new-task-images, new-task-2), `panel` (panel,
    panel-max), `drawer`, `board`, `inbox`, `library`, `project` (projects-2, project-page, project-new: **not** covered
    by `settings-`, though they live under `#/settings/projects`), `settings-` (the 12 settings pages, memory and secrets
    included; or `settings-memory`, `settings-secrets`…), `workflow` (list, edit, runs, off, workflows-2), `palette`,
    `shortcuts`. The `-2` screens (board-2, drawer-2, inbox-2, workflows-2…) are the second-project fixtures (#217) and
    follow their prefix. The names: the `SCREENS` array and the `SETTINGS` list in `scripts/ui-check/check.mjs`; check a
    prefix matches something before trusting a run (`--only` with no match checks nothing).
  - **Full run** (no `--only`) only when the change touches something every screen shares: global styles (`styles.css`
    tokens and resets), the app shell or sidebar, shared headers, the side panel shell, fonts
    (`main.tsx` imports), or `scripts/ui-check` itself.
  - **One ui-check at a time** on the machine (two at once give false failures): `pgrep -fl check.mjs` first, wait if
    one runs.


## Screenshot tool
**Screenshot tool** (#133, `packages/engine/src/screenshot.ts`): agents have a built-in `screenshot` tool, one picture
of a route (`#/board`) or a workspace page (`pages/x.html`, `/api/files/<agent>/…`) at a width/height and theme, with
optional `clip`, `full_page`, `wait_for` and `actions` (click, type, press). It runs a fresh headless Chrome against the
engine it runs in (no port lookup), refuses every write from the page (the main-chat lookup gets a read-only answer),
fails after 15 s naming what never appeared, and returns page errors + refused writes with the picture (saved under
`screenshots/`). Unit tests: `screenshot.test.ts` (fast); real Chrome: `test/screenshot.chrome.test.ts` (slow project).

## UI how-tos
- Styles are global: a class named after data (`card`, `board`, `panel`) collides with the board's CSS. Prefix dynamic
  class names (`rowic-<name>`) and update the selectors in `scripts/ui-check` when renaming.
- The task view is `packages/ui/src/CardView.tsx`, shared by `CardModal.tsx` and `ThreadPanel.tsx`: edit it for both.
- `ui-check` tests the built UI (`npm run build` first: a stale `packages/ui/dist` gives false errors) and needs
  `npm ci` once in the clone ("Cannot find package 'sharp'" otherwise). Several runs at once give false failures
  (layout width, "never showed .settings"): check `pgrep -fl check.mjs`, rerun the failing screens alone with `--only`
  and `--widths`. The OCR reading "All" as "AIl" or "Links" as "LInks" is a known quirk: the
  comparison folds `i`, `I` and `l` into one letter (nothing else is forgiven).
- An HTML mockup in the side panel gets the panel's width, so a page with a 640 px breakpoint shows its phone layout
  there: judge the desktop layout full size (`/api/files/<agent>/pages/<file>.html`).

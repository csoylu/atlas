# #113 · Verification of the #112 visual pass (PR #5, feat/112-bigger @ 2590fce)

Checked on the built UI of 2590fce against the live engine, 4 widths (1440/1100/768/390) × dark/light × 44 screens
(`check.mjs --spec`: computed-style audit + OCR), plus `landed.mjs`. Screenshots: `reports/113/`.

## Passes
- **Faces**: every `.dot-avatar` is the agent face (sidebar, crumb, board cards, inbox, chat `.who`, history, task view, library). No letter avatars left (the "U" hits in the first run were the `<text>` of the SVG initial for the `user` pseudo-agent: audit now counts only real text nodes; none remain).
- **Measures** (sidebar 244, rows 32, agent rows 36 / phone 44, header 48, step rows 36 / 44 coarse, pins 40 / 44, chat 780, lanes 300, task view 720): all as spec. Two audit false alarms fixed in the audit: sidebar is a 60 px rail beside a side panel by design; empty board lanes fold to 40 px.
- **Status chips** Working / Blocked / Done: colours = `--wk/--bk/--dn` tokens in both themes; chip text contrast ≥ 4.5 in all screens.
- **Font scale**: only 13/14/16/20 px computed in every screen; nothing under 13 px (exceptions: phone inputs 16, aria-hidden favicon letter). Weights 440/530/670.
- **Type test**: appending `.zz-mut{font-size:15px}` and `…11px` to styles.css makes `typeRules.test.ts` fail (mutation-checked). 9 + 4 tests pass.
- **`.landed`** (`scripts/ui-check/landed.mjs`, 8 checks, 3 runs stable): a Done report that arrives over the WebSocket gets `.landed` with `land-in` + `land-chip` (1 iteration); later messages do not replay it; reload and history load show none; `prefers-reduced-motion` → `animation: none`.
- **Phone drawer** (new `drawer` screen in ui-check): rows 44, faces, 13 px labels, no overflow.
- **Layouts**: no horizontal overflow, clipping or overlap found at any width/theme. Running tasks in the sidebar truncate correctly (munih's fix holds); phone composer shows "65%" fully.

## Issues (contrast < 4.5:1, computed colours; all CSS colour/opacity tweaks, none structural)
| # | Sev | Where | Theme | Value | Cause |
|---|-----|-------|-------|-------|-------|
| 1 | high | Inbox kind label `.ibx-k` ("Needs your input" orange, review green) | light | 2.62:1 / 3.26:1 | label uses the dot colour (`#e8833a`, `#2f9e6a`) as text; use `--bk-ink` / `--dn-ink` |
| 2 | high | Diff counts `span.add` "+146" (every chat tool row, task rows) | light | 3.38:1 | green `#2f9e6a` on white; `span.del` 4.38:1 |
| 3 | med | Stop button `.cm-stop` white on red `#eb5757` | dark | 3.48:1 | darker red or dark text |
| 4 | med | `--faint`-type text on tinted/hover rows: `.ni-when`, `.settings-count`, `.pal-note`, `.mem-id`, `.mem-when`, `.fv-n` / `.fv-dl.h` | dark 4.0–4.4, light 4.0–4.4 | text token `#80858d` / `#6a6e75` is ~4.5 on the page bg but drops on raised/hover/diff-line bgs; lift the token one step |
| 5 | med | Schedules: paused rows (`.muted`, prompt, ghost buttons, badge) at opacity .62 | both | 2.8–3.3:1 | information text, so dim by colour not opacity (or ≥ .8) |
| 6 | low | Dimmed on purpose: memory non-active rows, Settings > Voice disabled fields (opacity .5), `.kbd` .7 on accent (3.85), `.rec` .75 (4.15–4.3), `ansi-dim` 4.43 | both | 2.0–4.4 | disabled/secondary, but memory rows and Voice labels still carry information |

Not issues: sidebar rail at 60 px beside side panel; folded empty lane 40 px. Known flakes (pass on re-run, not reproducible 4×): light 1440 `chat-tools-canvas` OCR; one `chat-composer` 756 px width at 390 (composer test after 30 lines).

## Regression coverage added (scripts/ui-check, branch qa/113-verify)
- `check.mjs --spec` + `spec-audit.mjs`: font scale, exceptions, contrast on computed colours (incl. opacity), measures, faces, chips; `drawer` screen.
- `landed.mjs`: the animation rules above.

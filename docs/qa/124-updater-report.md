# QA report: the app updater (#124, tests #123, design `docs/updater.md`)

18 Nov 2026, zurich. Nothing was run against `/Applications/Atlas.app` or the live database: every case uses a fake GitHub
(`packages/engine/test/updaterKit.ts`), a fake `Atlas.app` in a temp folder and a throwaway engine. The one real
one-click update of the installed app stays #123's own acceptance test (not done here).

## Result: 3 bugs (below), everything else passes

| # | Bug | Severity | Test (stays green while the bug exists, goes red when fixed) |
|---|---|---|---|
| 1 | The swap is two renames (old → `Atlas.previous.app`, new → `Atlas.app`). If the helper dies between them (SIGKILL, logout, power loss) there is **no Atlas.app** until someone moves `Atlas.previous.app` back. Design says "the installed app must still open, old or new, never a broken one". | Medium (tiny window, but it is the one case that bricks the install) | `updater.qa.test.ts` › helper killed between the two renames (`it.fails`) |
| 2 | GitHub answers 200 with HTML (captive portal, proxy): Settings → About shows the JSON parser's message instead of a readable one. | Low | `updater.qa.test.ts` › not JSON (`it.fails`) |
| 3 | A release title or note with a long unbroken word (a path, a URL) is clipped in the update dialog and the notes box scrolls sideways, at 1440 and 390 px. Notes come from changelog sentences, so it will happen. Fix: `overflow-wrap: anywhere` on `.update-note-title` / `.update-note-body`. | Low | `e2e/tests/updater.spec.ts` › long unbroken word (`test.fail`) |

## Cases of the card

Automated = file › what.

**Release pipeline** (`scripts/release/pipeline.test.ts`, `changelog.test.ts`; real git histories + a read of `ci.yml`)
- One entry → next version, notes = that entry. No entry, two entries (even valid), only an intro edit, deleted file, unknown kind: refused with a message. A `##` inside an entry body counts as a new entry (agents must use `###`): refused and says why.
- Fixed → patch; Added / Changed → minor; Breaking → major (lower parts reset).
- Failing tests give no release: the Mac build needs `test` and `changelog`, the release needs the Mac build; a version whose tag exists fails the push.
- Pushes close together: each gets its own strictly increasing version in merge order, whatever build finishes first; two branches that both add an entry on top conflict, so the second rebases and gets the next version. A merge commit with three entries is refused.
- By hand / not automatable here: a real run of the workflow on GitHub (its runs are the evidence: every release since #123 went through it).

**Update check** (`updater.test.ts`, `updater.qa.test.ts`)
- Newer / same / older version; out-of-order releases (newest wins, a late older one is never offered); drafts and pre-releases ignored; no release, odd tags, no notes.
- No network, 403/429 rate limit, JSON that is not a list: clear error, the update found before is kept, the next good check clears it. HTML answer: bug 2. Two checks at once = one request; no credentials sent.

**Update itself**
- Bad checksum (also: no line for this zip, empty file, upper case / CRLF / `*` accepted), a zip that is not a zip, another version than its tag, no Atlas.app inside: failed with the reason, installed app untouched, no download left.
- Download cut halfway, ended early without length, stalled, redirect: error, partial file removed, retry works.
- Atlas killed (SIGKILL) during the download: next start drops the partial file, the app is untouched, Update works. Killed right after Update (before the swap): the helper still swaps and reopens. Atlas never quits: failed with a reason, app untouched. Helper killed while waiting: old app intact. Helper killed between the renames: **bug 1**. Folder not writable, new app vanished, stale previous app: the old app is reopened or put back.
- Several versions skipped: installs the latest, the dialog lists every note, the backup is named after the target. Update clicked twice: one download. Database backup failing stops the update before the swap.

**While agents work** (`e2e/tests/updater.spec.ts`, real engine + scripted model + real `sleep` commands)
- Two agents each running a command; the dialog lists both ("2 agents are working now…"); Update and restart → Atlas quits, the helper swaps the fake app to the new version; the new engine marks both runs `interrupted`, resumes both, they finish; every earlier message is still there, the resumed model call sees the task and its own tool call, no command from before the restart is still running; Settings → About says "Updated from 0.4.0 to 0.5.0".

**UI** (`e2e/tests/updater.spec.ts`; screenshots in `e2e/shots/updater/`, 8 states × 4 variants, looked at on real screenshots)
- 1440 and 390 px × dark and light: badge ("Update available 0.7.0", title), dialog (newest first, kind chips, markdown table in notes, agents working, Esc closes), downloading (progress, Later and Esc disabled), failed (error, Try again, badge "Update failed"), Settings → About (available, failed check with the update kept, Check now). Each state checked for: no sideways page scroll, dialog inside the viewport, buttons reachable, nothing wider than the dialog, text contrast ≥ 4.5:1 on 19 selectors. Up to date / older release: no badge; app that cannot install itself: button disabled with the reason. Only bug 3 found.

## Notes
- Flake seen once (1 run in ~10) in "update while two agents work" under machine load; 4 reruns in a row passed. If it returns: look at `r.atlas.restart` timing before the resume.
- Run: `npm run build`, then `cd e2e && E2E_CHANNEL=chrome npx playwright test updater`; engine side: `npx vitest run --project fast packages/engine/src/updater.test.ts packages/engine/test/updater.qa.test.ts scripts/release`.

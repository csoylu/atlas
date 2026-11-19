## Changed · #295 · Every model request is about 60 % smaller before the first message: shorter CLAUDE.md, tool descriptions and engine text, with no rule dropped
### What moved
- CLAUDE.md (27,724 chars, cut at 20,000 so its end was never read) is now 5,385 chars: stack, layout, rules, commands and the short release flow. The reference detail moved, word for word, to `docs/ui.md`, `docs/testing.md`, `docs/releases.md` and `docs/howtos.md`, each named in CLAUDE.md with when to read it.
- Tool specs: zod's ±MAX_SAFE_INTEGER bounds, defaults the type already says and repeats are gone from the JSON schemas; descriptions say each thing once. 25,142 → 17,587 chars (−30 %). No tool removed, no parameter renamed.
- Engine text (system prompt, memory intro, secrets block): 4,552 → 3,588 chars; the three « never validate by hand » lines are one.
- `promptSize.test.ts` fails if the system text or the tools JSON grows past its budget.

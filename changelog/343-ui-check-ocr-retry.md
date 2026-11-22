## Fixed · #343 · ui-check no longer fails on a chat row whose text Vision dropped but whose chevron or time it read

### Details
- At 1100 px Apple Vision sometimes read only the chevron or the time of a chat row (« > », « ‹ Wd L9:80 ») and not its text. The retry on crops (#328) only started for a label with nothing at all in its box, so these labels failed without a second read. It now starts for every label whose text was not read (same match as the verdict), with the same margins; text truly unreadable still fails, and the confidence bar (0.5) and the match tolerance are unchanged.
- The matching moved to `scripts/ui-check/ocrmatch.mjs` with tests. Test tooling only: no change in the app.

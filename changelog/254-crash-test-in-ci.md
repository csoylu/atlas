## Changed · #254 · CI now runs the crash test and the real-Chrome screenshot test on every pull request; voice tests stay local.

The `test` job adds the durability test (30 random SIGKILLs, design §6) and the screenshot tool against the runner's
Chrome. Voice suites need local models, so they still run only with `npm run test:full`: whoever touches voice runs it
before review and says so. `vitest.config.ts` and CLAUDE.md now say what runs where.

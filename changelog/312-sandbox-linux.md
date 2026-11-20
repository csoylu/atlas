## Added · #312 · On a Linux server, agent commands can run in a bubblewrap sandbox too, still off until it is switched on for everyone: nothing changes for you yet.

- With `ATLAS_SANDBOX=1`, every agent command on Linux runs under `bwrap`: the system read-only, its own workspace and private temp folder read-write, its own `/tmp` and process namespace; your home, the database and other workspaces do not exist inside it.
- The startup probe says what is wrong and how to fix it: bubblewrap missing, or Ubuntu 24.04 blocking user namespaces (AppArmor profile or sysctl). Windows: agent commands stop with « no sandbox on Windows ».
- Server setup: `docs/server-sandbox.md`. CI runs the same isolation test as on the Mac on ubuntu-24.04 (job `sandbox-linux`).

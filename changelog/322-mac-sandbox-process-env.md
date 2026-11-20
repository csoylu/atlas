## Fixed · #322 · On a Mac, a sandboxed agent command can no longer read other processes' secrets and arguments or signal them, and the engine's model keys no longer reach the programs it starts

### Details
- The Seatbelt profile denies the `kern.procargs` sysctls with every `process-info` check outside the command's own sandbox, the sysmond service (`pgrep`/`pkill`) and signals outside the command's process tree. Before, the raw sysctl returned the argv and environment of any process of the user (granted secrets, the proxy token) even though `ps` was denied.
- Inside a Mac sandbox, `pgrep` and `pkill` stop working and a command can only signal its own processes: stop background servers with `shell_kill`. `nohup` keeps working (the sandbox puts its own, SIGHUP-only, first on PATH).
- At start the engine removes model keys, plan tokens and `ATLAS_PASSWORD` / `ATLAS_SECRETS_PASSWORD` from its process environment, which gh, git, Chrome and ollama inherit (server and dev mode on a Mac).
- Applies when the sandbox is on (`ATLAS_SANDBOX=1` until S5).

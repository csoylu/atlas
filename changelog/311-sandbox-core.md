## Added · #311 · Agent commands can run in a per-workspace macOS sandbox (Seatbelt), off until it is switched on for everyone: nothing changes for you yet.

- With `ATLAS_SANDBOX=1` (temporary, for test engines), every agent command (shell, background shell, `secret_set`'s command, workflow command steps) runs under a Seatbelt profile of its own workspace: it cannot read your home (toolchains aside), other workspaces, the database, the shared `/tmp`, the keychain, the engine API or docker, and cannot escape through LaunchServices.
- HOME is the workspace, TMPDIR a private folder under the data dir; git uses https with the project's `GH_TOKEN` secret, and says how to ask for it when it is missing, never a prompt.
- A startup probe fails closed: if the sandbox can't run, runs stop with « Sandbox unavailable: … »; `GET /api/sandbox` shows the state.

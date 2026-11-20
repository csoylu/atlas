## Changed · #316 · Agents' commands now run in a sandbox

### What changes for you
- Every command an agent runs (shell, background shell, `secret_set`'s command, workflow command steps) runs in a sandbox of its own workspace: Seatbelt on a Mac, bubblewrap on a Linux server. It is always on, with no setting or variable to turn it off (`ATLAS_SANDBOX` is gone).
- Inside it a command writes only in its own workspace and private temp folder. It cannot read another agent's or another project's workspace, your home (`~/.ssh`, `~/.config/gh`, keychains), the Atlas database, the shared `/tmp`, the engine's port or Docker, and cannot open apps.
- git and gh no longer use your own GitHub login or ssh keys inside the sandbox: they use each project's `GH_TOKEN` secret (Settings → Secrets), a fine-grained token for that project's repo, granted to its members. Without it an agent's `git push` stops with « GH_TOKEN is not granted to you… » and the task blocks asking you for it. Atlas's own GitHub work (PR polling, review, merge, project clones) still uses your gh login, outside the sandbox.
- Internet follows each workspace's level (Settings → Workspaces): On, Allowed hosts or Off.
- Fail closed: if the sandbox cannot start (no `sandbox-exec`, bubblewrap missing or blocked on a server, Windows), agent commands stop with « Sandbox unavailable: … » instead of running unconfined. Chat, file tools and engine tools keep working. A server needs bubblewrap and socat first (docs/server-sandbox.md).
- On a Mac, since #322, a sandboxed command can no longer read other processes' arguments and environment or signal them; `pgrep`/`pkill` do not work inside it.

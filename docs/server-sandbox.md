# Server mode: the agent command sandbox on Linux (bubblewrap)

Every command an agent runs (shell, background shell, `secret_set`'s command, workflow command steps) runs in a
sandbox for its workspace (#298). On a Mac it is Seatbelt (`sandbox-exec`); on a Linux server it is
[bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`). Windows has no sandbox: agent commands stop there
with « Sandbox unavailable: no sandbox on Windows » (file tools, engine tools and chat still work).

> **Always on (#316):** there is no way to turn it off. Without a working bubblewrap every agent command stops with
> « Sandbox unavailable: … » (fail closed), so set the server up as below before updating.

## What an agent command sees

`bwrap --unshare-pid --unshare-ipc --die-with-parent --new-session`, starting from an empty root:

| | Inside the sandbox |
|---|---|
| `/usr`, `/etc`, `/opt`, `/sys`, `/bin`, `/lib*`, `/run/systemd/resolve` (DNS) | read-only |
| The folders of the command's `PATH` and `~/.nvm`, `~/.cargo`, `~/.rustup`, `~/.cache/ms-playwright` | read-only |
| Its own workspace, its private folder (`<data dir>/sandbox/<project>/<agent>`: `TMPDIR`, caches) | read-write |
| `/tmp` | a private, empty tmpfs |
| The rest of `$HOME`, the Atlas data dir (the database, other agents' workspaces, outputs) | **absent** (« No such file or directory »). A data dir inside `/opt` is hidden by an empty tmpfs |
| `/proc` | its own pid namespace: only the command's processes, never the engine's (its command line, its environment) |
| Network | per workspace (#298 S3, below): the host's at On; its own network namespace at Allowed hosts and Off |

`HOME` is the workspace. git and gh reach GitHub only with the project's `GH_TOKEN` secret; Master's gh login,
`~/.ssh` and the ssh-agent never enter a sandbox. Killing a command (or the engine) ends every process it started.

## Setup

### 1. Packages

```sh
sudo apt-get install -y bubblewrap socat   # Debian, Ubuntu
sudo dnf install -y bubblewrap socat       # Fedora, RHEL
```

`socat` is used by the « Allowed hosts » internet level (#298 S3): install it now.

### 2. User namespaces

bwrap runs unprivileged (never setuid) and needs unprivileged user namespaces. Most distributions allow them.
**Ubuntu 23.10 and later (24.04 included) block them as shipped**, and the engine's startup probe then reports:

> Sandbox unavailable: bwrap cannot create a user namespace (bwrap: setting up uid map: Permission denied): this system
> restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1, Ubuntu 23.10+). Fix: …

Pick one fix:

**A. An AppArmor profile for bwrap (recommended).** Only `/usr/bin/bwrap` gets user namespaces; the restriction stays
for every other program. The profile is [`server-sandbox/bwrap.apparmor`](server-sandbox/bwrap.apparmor):

```sh
sudo install -m 644 docs/server-sandbox/bwrap.apparmor /etc/apparmor.d/bwrap
sudo apparmor_parser -r /etc/apparmor.d/bwrap
```

It stays across reboots. CI (job `sandbox-linux`, ubuntu-24.04) installs this exact file before the isolation test.

**B. Lift the restriction for the whole machine.**

```sh
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-atlas-userns.conf
sudo sysctl --system
```

Other messages the probe can give:
- `kernel.unprivileged_userns_clone=0` (older Debian): `sudo sysctl -w kernel.unprivileged_userns_clone=1`, and the
  same line in `/etc/sysctl.d/` to keep it.
- `user.max_user_namespaces=0`: `sudo sysctl -w user.max_user_namespaces=15000`, and in `/etc/sysctl.d/`.
- « bubblewrap is not installed »: step 1.

Restart Atlas after the fix: the probe runs once, at start.

### 3. Check

```sh
bwrap --ro-bind / / true && echo ok          # user namespaces work
curl -s http://127.0.0.1:4317/api/sandbox     # once logged in: {"enabled":true,"kind":"bwrap","ok":true,"reason":null}
```

If the probe fails, every agent command stops with « Sandbox unavailable: <reason>. Agent commands are stopped. », on
the task and in `GET /api/sandbox`. There is never a fallback to running on the host.

## Internet levels (#298 S3)

Each workspace has a level, the project's by default (On), set in Settings → Workspaces or through the API
(`PATCH /api/projects/:id {network, allowedHosts}`, `PATCH /api/projects/:id/members/:agent`). A change applies from
the workspace's next command; a background command keeps the level it started with.

| Level | Inside the sandbox |
|---|---|
| **On** | The host network. The engine's port is reachable, so **the engine must run with `ATLAS_PASSWORD`**: then every API call needs a login (only `/api/health`, the login and webhooks `POST /hook/<token>` are public). Without a password, a command at On is refused with that reason |
| **Allowed hosts** | `--unshare-net`: a network namespace of its own (only its loopback). The engine's allow-list proxy is bound in as a unix socket; `socat` relays it to `127.0.0.1:3128`, and `HTTPS_PROXY`/`HTTP_PROXY` (with the workspace's token) and `NODE_USE_ENV_PROXY=1` point there. Only the listed hosts (`host` or `*.suffix`) pass; the others get 403 and are recorded (`GET /api/projects/:id/refusals`). No DNS, no UDP, no direct connection. Needs `socat` |
| **Off** | `--unshare-net`: nothing gets out; the command's own servers on its loopback still work |

`web_fetch` runs in the engine and applies the same level (every redirect hop is checked); `web_search` is not
offered at Off. The model API, PR polling, project clones and the updater are the engine's own calls: levels never
apply to them.

## Also

- **Keep the engine's own secrets out of readable files outside the data dir.** `/etc` is visible read-only: an
  `EnvironmentFile` with `ATLAS_SECRETS_PASSWORD` must be root-only (`chmod 600`, systemd reads it as root), or live
  in the data dir.
- **Other processes (#322).** Under bwrap the pid namespace hides them. On a Mac, Seatbelt shares one process table, so
  the profile denies the raw `kern.procargs` sysctls with every `process-info` check outside the command's own sandbox
  (another command's argv and environment: granted secrets, the proxy token), the sysmond service (so `pgrep`/`pkill`
  don't work in a Mac sandbox) and signals outside the command's own process tree. Stop a background server with
  `shell_kill`. macOS's `nohup` needs launchd, which that denial refuses: the sandbox puts a `nohup` that only
  ignores SIGHUP first on `PATH`. The engine also takes model keys, plan tokens and its passwords out of its own
  environment at start, so the processes it starts (gh, git, Chrome, ollama) don't carry them.

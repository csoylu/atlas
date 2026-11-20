# Server mode: the agent command sandbox on Linux (bubblewrap)

Every command an agent runs (shell, background shell, `secret_set`'s command, workflow command steps) runs in a
sandbox for its workspace (#298). On a Mac it is Seatbelt (`sandbox-exec`); on a Linux server it is
[bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`). Windows has no sandbox: agent commands stop there
with « Sandbox unavailable: no sandbox on Windows » (file tools, engine tools and chat still work).

> **Status (#298 S2):** the sandbox is on only when the engine starts with `ATLAS_SANDBOX=1`. It becomes always on,
> with no way to turn it off, in S5. Set the server up now so that switch changes nothing.

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
| Network | the host's (internet level On). The levels On / Allowed hosts / Off come with #298 S3 |

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

## Until #298 S3

- **Set `ATLAS_PASSWORD`, even with the engine on 127.0.0.1.** Agent commands share the host network, so they can
  reach the engine's port; with a password every API call needs a login. S3 separates the agent's network.
- **Keep the engine's own secrets out of readable files outside the data dir.** `/etc` is visible read-only: an
  `EnvironmentFile` with `ATLAS_SECRETS_PASSWORD` must be root-only (`chmod 600`, systemd reads it as root), or live
  in the data dir.

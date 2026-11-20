## Added · #313 · Each workspace can get an internet level (On, Allowed hosts or Off), still off until the sandbox is switched on for everyone: nothing changes for you yet.

- With `ATLAS_SANDBOX=1`, agent commands follow their workspace's level: the project's (On by default) unless the workspace sets its own. A change applies from the next command.
- **Allowed hosts**: commands reach the internet only through a proxy inside the engine, with a token per workspace, and only the listed hosts (`github.com`, `*.npmjs.org`). A refused host gets « <host> is not in this workspace's allowed hosts » and is counted, ready for an « Allow » button in Settings → Workspaces. No DNS, no UDP, no direct connection.
- **Off**: nothing gets out; the agent's own servers on localhost still work. `web_search` is not offered.
- `web_fetch` applies the level too, at every redirect hop.
- API: `PATCH /api/projects/:id` and `PATCH /api/projects/:id/members/:agent` take `network` and `allowedHosts`; `GET /api/projects/:id/refusals` lists the refused hosts.
- On Linux, level On shares the host network, so the engine refuses such commands unless it runs with `ATLAS_PASSWORD` (every API call then needs the login). Allowed hosts needs `socat` there (`docs/server-sandbox.md`).

## Changed · #272 · Settings follow the redesign: one header with « Find a setting », three groups (Team, Models, App), Agents as a list of rows, Memory rows showing their scope, and one « Models & accounts » page.

- Navigation: Team (Projects, Agents, Memory, Board & triage, Secrets), Models (Models & accounts), App (About you, Appearance, Voice, Usage, About & data). « Find a setting » in the header searches page names and a few keywords per page; no match says so.
- Models & accounts: Subscriptions, API keys, Local (Ollama) and Model list are four sections of one page, one link each at the top. The old links (#/settings/subscriptions, /api-keys, /local, /model-list, #/models) open the matching section; the command palette lists the four sections too.
- Agents: one row per agent (face, id, role and projects, model by its friendly name, « N at once », memories). The row opens the agent's page at #/settings/agents/<id> with the on/off switch, role, model, parallel runs, folder, memory and delete.
- Memory: each row shows its kind, text, id (m12) and scope (Global, a project for every agent, or one agent in a project). A click opens the row's detail with when, by whom, the source, Edit, Pin, Restore and Archive. The background review folds below the list.
- Phone: #/settings is a list of the pages; each page has a back button and its name as the title.
- The command palette closes on Esc wherever the focus is.

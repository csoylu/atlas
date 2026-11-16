# Atlas

An opinionated AI agent harness. A small team of agents works off a kanban board, on your own subscriptions and
models, with a shared canvas and a voice assistant that runs on your machine.

## Why

I tried a lot of harnesses: proprietary ones, open-source ones, paid ones. Some tried to cover every use case, others
were buggy and hard to use. So I built the one I wanted to use every day.

Atlas is simple, opinionated and ready to use. It doesn't have plugins or a skill store, and it has very few
settings. Agents work like a small team on a board you can see, and they keep going after a restart.

## What it does

- **Agents.** Named agents, each with a role, a model, a tool set, a working directory and its own memory. Chat with
  any of them directly. They create cards, write on each other's cards and edit their own memory.
- **Kanban board.** Cards are assigned to agents and run on their own. An agent can block a card with a question
  (with options), hand it over for review or complete it with a summary. Raw ideas go into *triage*, and an agent
  rewrites them, splits them and sets the assignee and priority. Parent cards gate their children. When a ready card
  isn't starting, the card tells you why.
- **Schedules.** Cron or one-shot, in your timezone, sending a prompt to any agent. If the engine was down when a
  schedule was due, it runs once at start.
- **Canvas.** An infinite board you and the agents both edit live. It holds Excalidraw drawings, HTML mockups, running
  apps (a dev server or a built `dist/`) and markdown notes.
- **Documents.** Agents write specs, pages and diagrams (`.md`, `.html`, `.svg`) and open them in a side panel next
  to the chat. Every change is versioned and can be restored. Everything ends up in the Library.
- **Voice assistant (Mac app).** Say « Hi Atlas »: an orb appears, you talk, and the agent answers out loud while the
  caption types. Speech recognition (Whisper large-v3-turbo, English and Turkish) and the voice (Supertonic) run
  locally with sherpa-onnx. No cloud speech service and no per-minute cost.
- **Prompts managed for you.** Atlas builds each system prompt from the agent's role, who you are, the team, the
  card, its memory and the project's `CLAUDE.md`/`AGENTS.md`. There are no prompt files to maintain. Long
  conversations are pruned and summarized near the context limit, but the full transcript is kept and agents can
  search it.
- **Built-in tools.** Files, ripgrep, shell (including background processes), web fetch and search, cards, canvas,
  schedules, memory and documents.
- **Usage.** Tokens per model and per day, plus a context gauge and your subscription quota next to the composer.
- **Light and crash-safe.** One Node process and one SQLite database (WAL), with no other state store. Every state
  change is a transaction. If you kill it at any moment and restart, every run resumes where it stopped, and an
  interruption doesn't count as a failure.
- **Desktop or server.** A Mac app (Electron), or the same engine on a VPS with a password login, opened in a browser.

## Models and subscriptions

Pick a model per agent, and override it per card or chat if you need to. Atlas never quietly switches to another model:
if a model is down, the run stops and shows the error.

- **Anthropic API keys.** Add several and they fail over in order, with cooldowns on 429s and billing errors.
- **Claude subscription.** Sign in with your Claude plan through OAuth.
- **ChatGPT plan.** OpenAI's *Sign in with ChatGPT*. Atlas registers under its own name.
- **Local models.** Atlas starts and supervises Ollama (and offers to install it with Homebrew), and pulls models
  from its library. Any OpenAI-compatible server (llama.cpp, LM Studio, vLLM) works too.

You can sign in more than one Claude or ChatGPT account. When one hits its usage limit, it's paused until its reset
time and the work moves to the next account. Keys and tokens are stored in the macOS Keychain on desktop and in
environment variables on a server. They never go into the database, the logs or the UI.

## Quick start

Requirements: Node 24+, and macOS for the desktop app and voice.

```sh
git clone https://github.com/csoylu/atlas && cd atlas
cp .env.example .env     # optional: ANTHROPIC_API_KEY etc. Keys can also be added in the app.
npm install
npm run dev              # engine + UI with hot reload → http://localhost:5173
npm run desktop          # the same, in the Electron window
```

Install it as a real Mac app (builds it, then replaces `/Applications/Atlas.app`, quitting the running one):

```sh
npm -w @atlas/desktop run install:mac
```

On first launch, give your name and a few words about yourself (Settings → About you). Then add a model under
Settings → Subscriptions, API keys or Local.

**Server mode:** `npm run build && npm start` serves the built UI from the engine (http://localhost:4317). Set `ATLAS_PASSWORD` (12+
characters) to require a login, keep the engine on `127.0.0.1` and put Caddy (HTTPS) or Tailscale in front of it.
See `.env.example`.

**Contributing:** `npm run typecheck && npm test` before every commit. The restart test and the agent-loop test with a
fake provider must stay green. Read [CLAUDE.md](CLAUDE.md) for the rules and [docs/design.md](docs/design.md) for the
full design.

## License

Copyright (C) 2026 Can Soylu

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General
Public License as published by the Free Software Foundation, version 3 ([LICENSE](LICENSE)). It is distributed WITHOUT
ANY WARRANTY. If you run a modified version for others over a network, you must offer them its source code (AGPL §13).

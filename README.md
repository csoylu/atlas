# Atlas

A personal agent harness: named agents, each with its own model, tools and memory, working off a shared kanban board,
on a schedule, with a shared canvas. TypeScript engine (SQLite), React UI, Electron desktop app.

Models: Anthropic API keys, Claude subscription OAuth, the ChatGPT plan (Sign in with ChatGPT),
and local models through Ollama or any OpenAI-compatible server.

```
cp .env.example .env
npm install
npm run dev        # engine + UI, http://localhost:5173
npm run desktop    # Electron app
npm run typecheck && npm test
```

Design: [docs/design.md](docs/design.md).

## License

Copyright (C) 2026 Can Soylu

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General
Public License as published by the Free Software Foundation, version 3 ([LICENSE](LICENSE)). It is distributed WITHOUT
ANY WARRANTY. If you run a modified version for others over a network, you must offer them its source code (AGPL §13).

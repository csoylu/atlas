## Added · #260 · A workflow can start on a webhook: a secret URL whose JSON body becomes payload fields, with filters, a loop guard and the last call shown on the trigger.

- Trigger « Webhook »: `POST /hook/<token>` with a JSON body (64 KB at most) starts the workflow; the body's fields are
  `{{payload.…}}` in every step and in « Insert a field », and marked as data in agent prompts.
- « Only if » tests on payload fields skip a call without a run; the loop guard turns the workflow off past its limit.
- The token is a secret: kept in the secret store (only its hash in SQLite), redacted from every output, given to no
  agent. A wrong token gets 404 and nothing of the body is kept. « New URL… » replaces it.
- Desktop: the URL is marked « reachable from this Mac only »; after a launch on another port the trigger shows
  « Unreachable since the last launch » with the old → new port until the new URL is copied. Outside services need
  server mode, where the route works without the UI login (the token is the credential) and reaches nothing else.

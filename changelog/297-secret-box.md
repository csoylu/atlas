## Added · #297 · When an agent needs a secret, you type its value in a box right where it asks (chat, task, Inbox) and the task restarts, no trip to Settings.

- The box shows the secret's name and the agent's description, a masked field (Show / Hide), Save and a link to Settings → Secrets; after Save it becomes « Saved NAME ».
- The value is stored like Settings → Secrets (keychain on desktop, secrets.enc on a server) and granted to the asking agent; it is never a chat message and never comes back from the API.
- An empty value, or a secret that already has one, is refused in the box and nothing is stored.

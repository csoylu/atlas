## Added · #242 · You can delete an artifact for good, from the Library or its viewer, and agents can delete their own when you ask.

- « Delete… » in the viewer's ⋯ menu and in each Library row's ⋯, with a confirm: the artifact, every version (securely erased) and its file go; its panel tabs close.
- A chat card of a deleted artifact stays in the thread and says « Deleted artifact ».
- New agent tool `artifact_delete`: the agent's own artifacts only, to use when you ask.
- API: `DELETE /api/documents/:id`. Deleting a folder still moves its artifacts to Unfiled.

## Fixed · #246 · A restart no longer resumes the run of an agent removed from the project (or of an archived project) while it was working

- Removing a member and archiving a project now stop the affected runs in the same database transaction, so a kill right after leaves nothing to resume.
- At start, a run whose agent is no longer a member of the task's project, or whose project is archived, is marked stopped with that reason: no « continue » message, no new run, the task stays with the lead.
- A shell command whose run was stopped just before it started no longer crashes the engine when its workspace is gone.

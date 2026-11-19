## Changed · #248 · Agents are now told in every run that their shell is not confined to a project, and to stay in their project's workspace
The engine isolates file tools, secrets, memory and instructions per project; the shell can still reach another
project's workspace by absolute path. This limit is now written down (docs/design.md §10 and §17, CLAUDE.md), and every
run's « # Workspace » says: shell commands stay in this working directory and the temp folders, and a lead crosses
projects through the tools' `project` parameter, not by path. Confining the shell is left for a later task.

## Added · #303 · Files in the chat's right pane: browse the agent's workspace, open and edit its files, and click file paths in chat to open them

The workbench pane (#302) gets its file kind, as in the approved mockup (#300).

- A tree of the chat agent's workspace for the project, with git letters (A, M), a filter (⌘P) and a toggle (⌘B).
- An editor (CodeMirror 6, loaded only when a file opens) with tabs, Save (⌘S) and a dot on unsaved tabs.
- If the agent changes a file you are editing, a banner offers Compare, Keep mine or Take the agent's. A save never silently overwrites the agent's write. If the agent deletes it, you can save it again or discard.
- Images are shown. Binary files and files over 1 MB are read only. A file holding a secret value is never shown.
- File paths in chat messages become links that open the file (`path:42` jumps to line 42). A path that doesn't exist stays plain code with a tooltip.
- Comment mode (#304) works on files: click a line number, shift-click or drag for a range, and the comment goes to the agent with the quoted lines.
- The engine reads and writes inside the same workspace boundary as the agent's file tools: no `..`, no absolute path, no symlink out, no other project's clone.

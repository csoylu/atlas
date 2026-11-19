## Changed · #266 · The Tasks board follows the redesign: one header row, new cards with project tag, priority name, time and PR pill, empty columns as thin rails, and a status strip on the phone

- Header in one row: Tasks, All projects, All · Needs you · Running, Filter, the board/list toggle, New task.
- Cards: title, then the agent, number, project, priority name and time in the column; one note (« waits for #N », « Needs your answer », why it is stuck) and one pill per PR with its worst state (CI running, conflicts, QA failed, merged…).
- Columns are 228 px wide; an empty column, Done and Closed included, is a 40 px rail, so nothing is cut at 1440 px.
- The list shows the same marks on each row.
- Phone: the status strip (Running, Review, Blocked first, then the queue, Done and Closed) picks the column shown.

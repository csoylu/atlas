## Changed · #265 · One set of buttons, status chips, priority marks, project tags, empty, loading and error states, plus a toast when a task's PR merges

- Priorities have names everywhere: High, Medium, Low, None (three bars). « P2 » is not printed any more.
- Status chips use the icon of the task's status (Closed included), project tags show the project's mark and Global a globe.
- One button set (`btn`, `primary`, `ghost`, `danger`, `icon-btn`), one empty state, skeleton rows while loading, and one error box that says what failed. They replace the old variants on every screen.
- A toast appears when a task goes from In review to Done because its PR merged while Atlas is open (never on load or reconnect). « Open » opens the task in the side panel.

## Fixed · #340 · A click on the Dock icon brings the Atlas window back after you closed it, like the menu bar's Open Atlas

### Details
- The Dock icon, the menu bar's « Open Atlas » and a second launch (Finder, Spotlight) now follow one rule: a new window if it was closed, the window shown (and restored if minimized) otherwise, nothing while Atlas is really quitting (#324).
- A quit refused by the page (unsaved file edits) no longer leaves Atlas « quitting » for good: before, the Dock icon stayed dead from then on, and the next red X quit the whole app.
- Each of these clicks writes its decision to `logs/voice.log` (« window dock: create », « window dock: nothing (quitting…) »), so a Dock icon that does nothing says why.

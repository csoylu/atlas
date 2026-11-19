## Changed · #236 · Pull requests of a project are now reviewed and merged one at a time, each brought up to date with main first, and a migration number already taken on main is renumbered on the way

- The tasks In review of a project form a queue in the order they asked for review; only the head gets a reviewer run. The others say « 3rd in the queue, behind #214 and #215 », the head how long it has been there.
- Before the review, Atlas rebases the head's PR onto main in the reviewer's clone and waits for CI on the new head. A real conflict goes back to the builder with the files named and the queue moves on.
- A new migration whose number main already took is renamed to the next free one (thread note « migration 0051_x renamed 0052_x »). CI and the QA gate refuse a new migration not numbered above main's.

## Changed · #249 · The merge queue of #236 is gone: every pull request In review gets its review as soon as its CI is green, without waiting for the others

- No more « 2nd in the queue, behind … » on cards, no automatic rebase after a merge and no automatic renaming of migration files. Migration 0057 drops the queue's columns.
- Stuck tasks In review (#237) count from the review request again.
- Kept: CI still refuses a pull request whose new migration is not numbered above every one on main; its builder renumbers it and rebases.

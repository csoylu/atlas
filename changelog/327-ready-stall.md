## Fixed · #327 · A Ready task that can't start now says why and reaches the Inbox, and a message from another agent starts its work instead of a side chat

### Details
- On 21 Nov task #326 showed « Ready · starting… » for 20 minutes with no run. A start that failed sent the task back to Ready with no reason, and an error on one task could stop every task after it from starting.
- Each task is now handled on its own: an error on one is shown on it (« could not start: … ») and the others still start.
- A task the dispatcher tries and fails to start stays in Ready with the reason, and after 2 minutes it is marked stuck, with an Inbox item.
- Atlas no longer starts any run once it is stopping, and a task says so instead of « starting… ».
- A message from another agent on a Ready task that can start now starts its work run (the task goes to Running), instead of a chat run doing the work while the task stays in Ready.

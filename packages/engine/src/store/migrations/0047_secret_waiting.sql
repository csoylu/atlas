-- « Needs secret X » (#207): the task blocked until this secret has a value (task_block with `secret`). When the user
-- adds the value (or grants it to the task's agent), the task goes back to work by itself and this is cleared.
ALTER TABLE secrets ADD COLUMN waiting_card TEXT;

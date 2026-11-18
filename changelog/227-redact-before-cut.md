## Fixed · #227 · A secret value cut in two where a long output is shortened no longer shows the part that was cut off

Every output that is shown cut is now redacted first and cut second: the shell's last 30000 characters (and the full
output saved to a file), the chat's live tail of a running command (a value still being written is held back until it
is complete, so one split across two chunks never shows in part), each page of a background process's log read with
shell_output and the tail in its exit note, long lines cut by read_file and grep, a page fetched by web_fetch, and the
stderr shown when secret_set's command fails. A value crossing a cut is shown as its whole `[secret NAME]` marker.

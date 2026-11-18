#!/bin/sh
# Card #57: CPU of every Atlas process (main + helpers) while speech plays from the speakers (like a video), SECS seconds.
# Prints the average % of one core, summed over Atlas processes, and the voice.log lines written meanwhile.
SECS=${SECS:-60}
LOG="$HOME/Library/Application Support/Atlas/data/logs/voice.log"
before=$(wc -l < "$LOG")
( end=$(( $(date +%s) + SECS )); while [ "$(date +%s)" -lt "$end" ]; do
    say -r 170 "Welcome back to the channel. Today we are looking at the market, bitcoin moved four percent overnight, and everyone is asking whether the rally can hold into the weekend. Let us look at the charts together." ; done ) &
player=$!
cpu() { ps -axo time=,command= | grep -F "/Applications/Atlas.app/" | grep -v grep | awk '{ split($1,t,":"); s += t[1]*60 + t[2] } END { printf "%.2f", s }'; }
a=$(cpu); sleep "$SECS"; b=$(cpu)
kill $player 2>/dev/null; killall say 2>/dev/null
echo "Atlas CPU: $(echo "$a $b $SECS" | awk '{ printf "%.1f%% of a core", ($2-$1)/$3*100 }') over ${SECS}s with speech playing"
echo "voice.log meanwhile:"; tail -n +$((before+1)) "$LOG" | cut -c1-140 | tail -8

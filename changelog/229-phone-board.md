## Fixed · #229 · On a phone the Tasks board shows one column at a time, picked from a row of status chips, instead of columns cut off at the right edge

At 640 px and below, a row of chips (status icon, name, count; 32 px tall, scrolls sideways) sits above the board and
the chosen column fills the width, with its « + » in reach. The empty Triage rail is gone there: Triage is a chip like
the others. The choice is kept across reloads (`atlas.board.col`); with none, the first column holding tasks shows.
Tablet and desktop are unchanged.

## Fixed · #228 · Settings → Usage: « Today » now counts Claude plan tokens and matches the table

The headline (Today, Peak day, active days) and the chart summed every source except the Claude plan, so a day spent
only on the plan showed « Today 0 · 43 calls » and no bar. All sums now go through one list of sources, tested against
the table's Today column. Claude plan bars get their own colour, the chart axis shows a date every 7 days up to
« Today » with the legend on its own row, and token counts past a billion read « 1.27B » instead of « 1266M ».

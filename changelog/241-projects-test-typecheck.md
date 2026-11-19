## Fixed · #241 · Main builds again: a projects UI test still used a project field removed the same day.

The #217 test fixture set `changelog` on a project; #238 had removed that field from `Project`, so `npm run typecheck` failed on main.

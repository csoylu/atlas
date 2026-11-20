## Changed · #310 · Atlas has its new icon, the Living Orb: in the Dock, the browser tab and the sidebar, where it breathes, swirls while agents work and shows an orange dot when something needs you
### Details
- Dock: the Living Orb .icns (full drawing from 128 px, the simple mark at 16 and 32 px); the Dock icon stays still and its badge counts the tasks needing you (cleared at zero).
- Sidebar mark: idle, the glow breathes every 4 s; working, the swirl turns every 3 s; needs you, the swirl stops and an orange dot knocks twice. Still with reduced motion, paused while the window is hidden.
- Favicon and login screen: the still mark. Sources: apps/desktop/icon/*.svg, `node apps/desktop/icon/build-icon.mjs` rebuilds the icns.

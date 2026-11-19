## Fixed · #294 · A link to a raw JSON or text file is readable in the side panel and in Library tiles in dark theme (it showed white text on white).

### Cause
Frames had a hard-coded white background. In dark theme a frame inherits `color-scheme: dark`, so Chrome renders a raw
file (its JSON or text viewer) or a theme-aware page in dark colours on a transparent canvas: light text on our white.
Frames no longer get a background: a page without `color-scheme` still paints its own white canvas, the rest follow
the theme. Tile previews sit on the panel colour.

## Fixed · #253 · A converted canvas page you delete from the Library no longer comes back at the next start of Atlas.

The canvas conversion (#120) ran at every start for each canvas without a page, so a deleted converted page was made
again. Each canvas is now marked once converted (`canvases.converted_at`, migration 0058); databases where the
conversion already ran mark every canvas, so the four pages deleted on 19 Nov stay deleted.

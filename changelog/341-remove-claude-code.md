## Changed · #341 · The code left from the removed Claude Code provider is gone; any model still on it now runs on your Claude plan.

The legacy provider (0017, removed in 0018) leaves the engine, the API types and Settings (Model list label, the Usage page's « Removed Claude integration » source and colour). Migration 0071 turns any model row still on it into a Claude plan model with the same id (agents using it keep it; base URL and key variable cleared, marked untested) and counts its usage history under Claude plan; no row is deleted. The models table no longer accepts the value.

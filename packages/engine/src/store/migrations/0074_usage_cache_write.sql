-- Prompt tokens written to the provider's cache (#376: Anthropic's cache_creation_input_tokens), next to `cached`
-- (read from it). Writes cost more than plain input (1-hour breakpoints: 2x), so Settings → Usage shows them.
ALTER TABLE model_usage ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0;

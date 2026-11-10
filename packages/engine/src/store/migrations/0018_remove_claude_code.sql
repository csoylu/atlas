-- Preserve legacy models, agent/card references and usage history; never silently switch billing providers.
-- 0017 remains immutable. Its legacy provider value is readable, but is no longer executable or creatable.
UPDATE models SET verified_at = NULL,
  last_error = 'Claude subscription integration removed; direct OAuth requires Anthropic authorization. Select another supported model explicitly.'
WHERE provider = 'claude_code';

-- Site icons for web search and fetch results in the chat (#361): fetched by the engine from the site itself (never a
-- third-party service), once per domain. A miss is kept too (bytes NULL, the reason in `error`), so a site without an
-- icon is not asked again on every render. Hits are fetched again after ~30 days, misses after ~1 day (favicons.ts).
CREATE TABLE favicons (
  domain       TEXT PRIMARY KEY,
  bytes        BLOB,
  content_type TEXT,
  error        TEXT,
  fetched_at   TEXT NOT NULL
);

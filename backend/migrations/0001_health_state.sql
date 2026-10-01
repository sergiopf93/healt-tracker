CREATE TABLE IF NOT EXISTS health_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  pending_import TEXT,
  updated_at TEXT NOT NULL
);

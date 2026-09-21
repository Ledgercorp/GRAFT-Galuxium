CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users (email);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user_id ON sessions (user_id);

CREATE TABLE uploads (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL
);

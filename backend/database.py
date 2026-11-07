"""database.py - SQLite setup and small helper functions (built-in sqlite3 only)."""
import sqlite3
import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,          -- 'pdf' or 'text'
    filename TEXT,
    file_size INTEGER,
    page_count INTEGER,
    raw_text TEXT NOT NULL,             -- cleaned text; source sentences come from here
    summary TEXT,
    method TEXT NOT NULL,               -- 'ai' or 'rules' (how it was analysed)
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    deadline TEXT,                      -- ISO date 'YYYY-MM-DD' or NULL
    deadline_time TEXT,                 -- 'HH:MM' or NULL
    date_certain INTEGER DEFAULT 1,     -- 0 = date was guessed/unclear
    priority TEXT DEFAULT 'medium',     -- low / medium / high / urgent
    status TEXT DEFAULT 'pending',      -- pending / completed
    source_sentence TEXT,               -- exact sentence from the notice
    source_verified INTEGER DEFAULT 0,  -- 1 only if sentence was found in notice
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
"""


def get_db():
    """Open a connection; rows behave like dictionaries."""
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    with conn:
        conn.executescript(SCHEMA)
    conn.close()


def query(sql, params=()):
    """Run a SELECT and return a list of dicts."""
    conn = get_db()
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def execute(sql, params=()):
    """Run INSERT/UPDATE/DELETE. Returns the new row id (for INSERT)."""
    conn = get_db()
    try:
        with conn:
            return conn.execute(sql, params).lastrowid
    finally:
        conn.close()
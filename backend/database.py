
"""database.py - SQLite database setup and helper functions."""

import os
import sqlite3
import config


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,
    filename TEXT,
    file_size INTEGER,
    page_count INTEGER,
    raw_text TEXT NOT NULL,
    summary TEXT,
    method TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    deadline TEXT,
    deadline_time TEXT,
    date_certain INTEGER DEFAULT 1,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'pending',
    source_sentence TEXT,
    source_verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
);
"""


def get_db():
    """Create and return a database connection."""
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    """Create tables and safely update an existing database."""
    os.makedirs(os.path.dirname(config.DB_PATH), exist_ok=True)

    conn = get_db()

    try:
        with conn:
            conn.executescript(SCHEMA)

            # Add user ownership to an existing notices table.
            columns = [
                row["name"]
                for row in conn.execute("PRAGMA table_info(notices)")
            ]

            if "user_id" not in columns:
                conn.execute(
                    "ALTER TABLE notices ADD COLUMN user_id "
                    "INTEGER REFERENCES users(id) ON DELETE CASCADE"
                )

    finally:
        conn.close()


def query(sql, params=()):
    """Run a SELECT query and return rows as dictionaries."""
    conn = get_db()

    try:
        return [
            dict(row)
            for row in conn.execute(sql, params).fetchall()
        ]
    finally:
        conn.close()


def execute(sql, params=()):
    """Run an INSERT, UPDATE or DELETE query."""
    conn = get_db()

    try:
        with conn:
            return conn.execute(sql, params).lastrowid
    finally:
        conn.close()

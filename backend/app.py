"""
Notice2Action backend (Flask + SQLite).
Every user only ever sees their own notices, tasks and settings.

Run:   python app.py        (serves http://127.0.0.1:5001)
"""
import io
import json
import os
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from functools import wraps

from flask import Flask, g, jsonify, request, session
from flask_cors import CORS
try:
    import fitz  # PyMuPDF (better PDF text extraction, used when installed)
except ImportError:
    fitz = None
try:
    from pypdf import PdfReader  # fallback when PyMuPDF is not installed
except ImportError:
    PdfReader = None
try:
    import dateparser  # used for phrases like "tomorrow" or "next Friday"
except ImportError:
    dateparser = None
from werkzeug.security import check_password_hash, generate_password_hash

# ----------------------------------------------------------------------------
# Settings you may want to change
# ----------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "notice2action.db")

# Where your frontend is served from (must match the address in the browser exactly).
FRONTEND_ORIGINS = ["http://127.0.0.1:5500", "http://localhost:5500"]

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", "dev-only-change-this-secret"),
    MAX_CONTENT_LENGTH=12 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)

LANGUAGES = {"english", "hindi", "punjabi"}
PRIORITIES = {"low", "medium", "high", "urgent"}
STATUSES = {"pending", "completed"}


# ----------------------------------------------------------------------------
# CORS (lets the frontend on another port send the login cookie)
# ----------------------------------------------------------------------------
CORS(app, supports_credentials=True, origins=FRONTEND_ORIGINS)


# ----------------------------------------------------------------------------
# Database
# ----------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    student_name TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'english',
    reminder_days INTEGER NOT NULL DEFAULT 2
);
CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    source_type TEXT NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 0,
    file_size INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL DEFAULT 'rule',
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    deadline TEXT,
    deadline_time TEXT,
    date_certain INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'pending',
    source_sentence TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notices_user ON notices(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_notice ON tasks(notice_id);
"""


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.executescript(SCHEMA)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def err(message, code=400):
    return jsonify(error=message), code


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user_id"):
            return err("Please log in.", 401)
        return fn(*args, **kwargs)
    return wrapper


def uid():
    return session["user_id"]


def body():
    return request.get_json(silent=True) or {}


def task_dict(row):
    d = dict(row)
    d["date_certain"] = bool(d.get("date_certain"))
    d["source_verified"] = bool(d.get("source_sentence"))
    return d


TASK_SELECT = (
    "SELECT t.*, n.title AS notice_title FROM tasks t "
    "JOIN notices n ON n.id = t.notice_id "
)


def reminder_days(user_id):
    row = get_db().execute(
        "SELECT reminder_days FROM settings WHERE user_id = ?", (user_id,)
    ).fetchone()
    return row["reminder_days"] if row else 2


def read_pdf(data):
    """Returns (text, page_count). Uses PyMuPDF if installed, otherwise pypdf."""
    if fitz is not None:
        with fitz.open(stream=data, filetype="pdf") as doc:
            if doc.needs_pass:
                raise ValueError("password protected")
            return "\n".join(page.get_text() for page in doc).strip(), doc.page_count
    if PdfReader is None:
        raise RuntimeError("Install PyMuPDF or pypdf to read PDFs.")
    reader = PdfReader(io.BytesIO(data))
    return "\n".join((p.extract_text() or "") for p in reader.pages).strip(), len(reader.pages)


def valid_date(value):
    try:
        date.fromisoformat(value)
        return True
    except (TypeError, ValueError):
        return False


def valid_time(value):
    return bool(re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value or ""))


# ----------------------------------------------------------------------------
# Rule-based task extraction
# ----------------------------------------------------------------------------
MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sept": 9, "sep": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}
MON = "|".join(sorted(MONTHS, key=len, reverse=True))

DATE_NUMERIC = re.compile(r"\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b")
DATE_DAY_MONTH = re.compile(
    rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({MON})\b\.?,?\s*(\d{{4}})?", re.I
)
DATE_MONTH_DAY = re.compile(
    rf"\b({MON})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b,?\s*(\d{{4}})?", re.I
)

RELATIVE_DATE = re.compile(
    r"\b(today|tomorrow|day after tomorrow|(?:this|next)\s+"
    r"(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b", re.I
)

STRONG_WORDS = re.compile(
    r"\b(submit|submission|pay|payment|register|registration|attend|bring|complete|"
    r"apply|application|upload|fill|appear|collect|report to|enrol|enroll|deposit|return|renew)\b", re.I
)
MODAL_WORDS = re.compile(
    r"\b(must|should|required|need to|needs to|have to|kindly|please|no later than|before|by)\b", re.I
)
WEAK_WORDS = re.compile(
    r"\b(deadline|last date|last day|due|exam|examination|test|viva|assignment|project|"
    r"fee|fees|meeting|interview|presentation|result|admit card)\b", re.I
)


def find_dates(sentence, today):
    """Returns (iso_date, is_certain) for the first date in the sentence, or (None, False)."""
    found = []
    for m in DATE_NUMERIC.finditer(sentence):
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y = y + 2000 if y < 100 else y
        found.append((m.start(), d, mo, y, True))
    for m in DATE_DAY_MONTH.finditer(sentence):
        y = int(m.group(3)) if m.group(3) else None
        found.append((m.start(), int(m.group(1)), MONTHS[m.group(2).lower()], y, bool(y)))
    for m in DATE_MONTH_DAY.finditer(sentence):
        y = int(m.group(3)) if m.group(3) else None
        found.append((m.start(), int(m.group(2)), MONTHS[m.group(1).lower()], y, bool(y)))

    for _pos, d, mo, y, certain in sorted(found, key=lambda x: x[0]):
        try:
            if y is None:
                y = today.year
                candidate = date(y, mo, d)
                if (today - candidate).days > 60:      # probably next year
                    candidate = date(y + 1, mo, d)
            else:
                candidate = date(y, mo, d)
            return candidate.isoformat(), certain
        except ValueError:
            continue

    # No written-out date: try phrases like "tomorrow" or "next Friday" (needs dateparser).
    if dateparser is not None:
        m = RELATIVE_DATE.search(sentence)
        if m:
            parsed = dateparser.parse(m.group(0), settings={
                "PREFER_DATES_FROM": "future",
                "RELATIVE_BASE": datetime(today.year, today.month, today.day),
            })
            if parsed:
                return parsed.date().isoformat(), False   # relative dates are marked "uncertain"
    return None, False


def find_time(sentence):
    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b", sentence, re.I)
    if m:
        h, mi = int(m.group(1)), int(m.group(2) or 0)
        if 1 <= h <= 12 and mi < 60:
            if m.group(3).lower() == "p" and h != 12:
                h += 12
            if m.group(3).lower() == "a" and h == 12:
                h = 0
            return f"{h:02d}:{mi:02d}"
    m = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", sentence)
    if m:
        return f"{int(m.group(1)):02d}:{m.group(2)}"
    return None


def pick_priority(sentence, deadline, today):
    s = sentence.lower()
    hot = ("urgent", "immediately", "asap")
    important = ("last date", "last day", "compulsory", "mandatory", "final")
    if deadline:
        days = (date.fromisoformat(deadline) - today).days
        if days <= 2 or any(w in s for w in hot):
            return "urgent"
        if days <= 7 or any(w in s for w in important):
            return "high"
        return "medium"
    if any(w in s for w in hot):
        return "high"
    return "low"


def short_title(sentence, limit=110):
    text = re.sub(r"\s+", " ", sentence).strip(" -•*\t")
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut + "…"


def extract_tasks(raw_text, today=None):
    today = today or date.today()
    pieces = [p.strip() for p in re.split(r"(?<=[.!?])\s+|\n+", raw_text)]
    tasks, seen = [], set()
    for sentence in pieces:
        if len(sentence) < 12:
            continue
        deadline, certain = find_dates(sentence, today)
        strong = STRONG_WORDS.search(sentence)
        weak = WEAK_WORDS.search(sentence) or MODAL_WORDS.search(sentence)
        if not (strong or (deadline and weak)):
            continue
        key = sentence.lower()
        if key in seen:
            continue
        seen.add(key)
        tasks.append({
            "title": short_title(sentence),
            "description": sentence if len(sentence) > 110 else "",
            "deadline": deadline,
            "deadline_time": find_time(sentence) if deadline else None,
            "date_certain": 1 if (deadline and certain) else 0,
            "priority": pick_priority(sentence, deadline, today),
            "source_sentence": sentence,
        })
        if len(tasks) >= 25:
            break
    return tasks


def make_summary(raw_text):
    flat = re.sub(r"\s+", " ", raw_text).strip()
    return flat[:320] + ("…" if len(flat) > 320 else "")


def conflicts_for(user_id, only_dates=None):
    """Days with several pending tasks. 'conflict' = same time, 'busy' = 3 or more tasks."""
    rows = get_db().execute(
        "SELECT deadline, deadline_time FROM tasks WHERE user_id = ? AND status = 'pending' "
        "AND deadline IS NOT NULL AND deadline >= ?",
        (user_id, date.today().isoformat()),
    ).fetchall()
    by_day = {}
    for r in rows:
        by_day.setdefault(r["deadline"], []).append(r["deadline_time"])
    out = []
    for day in sorted(by_day):
        if only_dates is not None and day not in only_dates:
            continue
        times = [t for t in by_day[day] if t]
        count = len(by_day[day])
        if len(times) != len(set(times)):
            out.append({"date": day, "level": "conflict",
                        "message": "Two or more tasks are due at the same time on this day."})
        elif count >= 3:
            out.append({"date": day, "level": "busy",
                        "message": f"{count} tasks are due on this day. Plan ahead."})
    return out


# ----------------------------------------------------------------------------
# Auth
# ----------------------------------------------------------------------------
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def user_json(row):
    return {"id": row["id"], "name": row["name"], "email": row["email"]}


@app.post("/api/auth/register")
def register():
    data = body()
    name = (data.get("name") or "").strip()[:60]
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not name:
        return err("Please enter your name.")
    if not EMAIL_RE.match(email):
        return err("Please enter a valid email address.")
    if len(password) < 8:
        return err("Password must be at least 8 characters.")

    db = get_db()
    try:
        cur = db.execute(
            "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)",
            (email, generate_password_hash(password), name),
        )
    except sqlite3.IntegrityError:
        return err("An account with this email already exists.", 409)
    user_id = cur.lastrowid
    db.execute("INSERT INTO settings (user_id, student_name) VALUES (?, ?)",
               (user_id, name.split()[0]))
    db.commit()

    session.clear()
    session["user_id"] = user_id
    row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return jsonify(user=user_json(row)), 201


@app.post("/api/auth/login")
def login():
    data = body()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    row = get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        return err("Incorrect email or password.", 401)
    session.clear()
    session["user_id"] = row["id"]
    return jsonify(user=user_json(row))


@app.post("/api/auth/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/auth/me")
def me():
    user_id = session.get("user_id")
    row = get_db().execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone() if user_id else None
    if not row:
        session.clear()
        return err("Not logged in.", 401)
    return jsonify(user=user_json(row))


@app.get("/api/status")
def status():
    return jsonify(ok=True, ai_available=bool(GEMINI_API_KEY))


# ----------------------------------------------------------------------------
# Settings
# ----------------------------------------------------------------------------
def settings_json(user_id):
    row = get_db().execute("SELECT * FROM settings WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        return {"student_name": "", "language": "english", "reminder_days": "2"}
    return {"student_name": row["student_name"], "language": row["language"],
            "reminder_days": str(row["reminder_days"])}


@app.get("/api/settings")
@login_required
def get_settings():
    return jsonify(settings_json(uid()))


@app.put("/api/settings")
@login_required
def put_settings():
    data = body()
    current = settings_json(uid())
    name = str(data.get("student_name", current["student_name"])).strip()[:60]
    language = str(data.get("language", current["language"])).lower()
    try:
        days = int(data.get("reminder_days", current["reminder_days"]))
    except (TypeError, ValueError):
        return err("Reminder days must be a number.")
    if language not in LANGUAGES:
        return err("Unsupported language.")
    if not 1 <= days <= 14:
        return err("Reminder days must be between 1 and 14.")
    db = get_db()
    db.execute(
        "INSERT INTO settings (user_id, student_name, language, reminder_days) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET student_name = excluded.student_name, "
        "language = excluded.language, reminder_days = excluded.reminder_days",
        (uid(), name, language, days),
    )
    db.commit()
    return jsonify(settings_json(uid()))


# ----------------------------------------------------------------------------
# Notices
# ----------------------------------------------------------------------------
def notice_row(notice_id):
    """Fetch a notice ONLY if it belongs to the logged-in user."""
    return get_db().execute(
        "SELECT * FROM notices WHERE id = ? AND user_id = ?", (notice_id, uid())
    ).fetchone()


@app.get("/api/notices")
@login_required
def list_notices():
    rows = get_db().execute(
        "SELECT n.id, n.title, n.source_type, n.method, n.created_at, "
        "(SELECT COUNT(*) FROM tasks t WHERE t.notice_id = n.id) AS task_count "
        "FROM notices n WHERE n.user_id = ? ORDER BY n.id DESC",
        (uid(),),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/notices")
@login_required
def create_notice():
    title = ""
    page_count = file_size = 0

    if "file" in request.files:
        f = request.files["file"]
        title = (request.form.get("title") or "").strip()
        data = f.read()
        if not (f.filename or "").lower().endswith(".pdf") or not data.startswith(b"%PDF"):
            return err("Only PDF files are allowed.")
        if len(data) > 10 * 1024 * 1024:
            return err("That file is over 10 MB.", 413)
        try:
            raw_text, page_count = read_pdf(data)
        except Exception:
            return err("Could not read that PDF. It may be damaged or password-protected.", 422)
        if len(raw_text) < 20:
            return err("No readable text found. Scanned images are not supported yet.", 422)
        source_type, file_size = "pdf", len(data)
        if not title:
            title = (f.filename or "Notice")[:-4][:80]
    else:
        data = body()
        raw_text = (data.get("text") or "").strip()
        title = (data.get("title") or "").strip()
        if len(raw_text) < 20:
            return err("Paste at least a few sentences.")
        source_type = "text"

    raw_text = raw_text[:60000]
    if not title:
        first = next((ln.strip() for ln in raw_text.splitlines() if ln.strip()), "")
        title = (first[:80] or "Untitled notice")

    db = get_db()
    cur = db.execute(
        "INSERT INTO notices (user_id, title, raw_text, source_type, page_count, file_size, method, summary) "
        "VALUES (?, ?, ?, ?, ?, ?, 'rule', ?)",
        (uid(), title[:80], raw_text, source_type, page_count, file_size, make_summary(raw_text)),
    )
    notice_id = cur.lastrowid
    for t in extract_tasks(raw_text):
        db.execute(
            "INSERT INTO tasks (user_id, notice_id, title, description, deadline, deadline_time, "
            "date_certain, priority, source_sentence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (uid(), notice_id, t["title"], t["description"], t["deadline"], t["deadline_time"],
             t["date_certain"], t["priority"], t["source_sentence"]),
        )
    db.commit()

    notice = dict(notice_row(notice_id))
    tasks = [task_dict(r) for r in db.execute(
        TASK_SELECT + "WHERE t.notice_id = ? AND t.user_id = ? "
        "ORDER BY t.deadline IS NULL, t.deadline, t.id", (notice_id, uid())).fetchall()]
    return jsonify(notice=notice, tasks=tasks, ai_warning=None), 201


@app.get("/api/notices/<int:notice_id>")
@login_required
def get_notice(notice_id):
    notice = notice_row(notice_id)
    if not notice:
        return err("Notice not found.", 404)
    rows = get_db().execute(
        TASK_SELECT + "WHERE t.notice_id = ? AND t.user_id = ? "
        "ORDER BY t.deadline IS NULL, t.deadline, t.deadline_time, t.id", (notice_id, uid())
    ).fetchall()
    tasks = [task_dict(r) for r in rows]
    dates = {t["deadline"] for t in tasks if t["deadline"]}
    return jsonify(notice=dict(notice), tasks=tasks, conflicts=conflicts_for(uid(), dates))


@app.delete("/api/notices/<int:notice_id>")
@login_required
def delete_notice(notice_id):
    if not notice_row(notice_id):
        return err("Notice not found.", 404)
    db = get_db()
    db.execute("DELETE FROM tasks WHERE notice_id = ? AND user_id = ?", (notice_id, uid()))
    db.execute("DELETE FROM notices WHERE id = ? AND user_id = ?", (notice_id, uid()))
    db.commit()
    return jsonify(ok=True)


@app.post("/api/notices/<int:notice_id>/simplify")
@login_required
def simplify(notice_id):
    notice = notice_row(notice_id)
    if not notice:
        return err("Notice not found.", 404)
    language = str(body().get("language", "english")).lower()
    if language not in LANGUAGES:
        return err("Unsupported language.")
    if not GEMINI_API_KEY:
        return err("This feature needs a Gemini API key. Set GEMINI_API_KEY and restart the server.", 400)

    prompt = (
        f"Explain this college notice to a student in simple {language.capitalize()}. "
        "Use short sentences and a few bullet points. Mention every deadline exactly as written. "
        "Do not invent any dates, fees or rules.\n\nNOTICE:\n" + notice["raw_text"][:8000]
    )
    payload = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY},
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            result = json.loads(resp.read().decode())
        text = result["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (urllib.error.URLError, KeyError, IndexError, ValueError, TimeoutError):
        return err("Could not get an explanation from the AI service. Try again later.", 502)
    return jsonify(explanation=text)


# ----------------------------------------------------------------------------
# Tasks, calendar, dashboard
# ----------------------------------------------------------------------------
@app.get("/api/tasks")
@login_required
def list_tasks():
    sql = TASK_SELECT + "WHERE t.user_id = ?"
    args = [uid()]
    status_f = request.args.get("status", "")
    priority_f = request.args.get("priority", "")
    if status_f in STATUSES:
        sql += " AND t.status = ?"
        args.append(status_f)
    if priority_f in PRIORITIES:
        sql += " AND t.priority = ?"
        args.append(priority_f)
    if request.args.get("sort") == "newest":
        sql += " ORDER BY t.id DESC"
    else:
        sql += " ORDER BY t.deadline IS NULL, t.deadline, t.deadline_time, t.id"
    return jsonify([task_dict(r) for r in get_db().execute(sql, args).fetchall()])


@app.patch("/api/tasks/<int:task_id>")
@login_required
def update_task(task_id):
    db = get_db()
    row = db.execute("SELECT * FROM tasks WHERE id = ? AND user_id = ?", (task_id, uid())).fetchone()
    if not row:
        return err("Task not found.", 404)

    data = body()
    changes = {}
    if "title" in data:
        title = str(data["title"]).strip()[:150]
        if not title:
            return err("Title cannot be empty.")
        changes["title"] = title
    if "description" in data:
        changes["description"] = str(data["description"] or "").strip()[:2000]
    if "priority" in data:
        if data["priority"] not in PRIORITIES:
            return err("Invalid priority.")
        changes["priority"] = data["priority"]
    if "status" in data:
        if data["status"] not in STATUSES:
            return err("Invalid status.")
        changes["status"] = data["status"]
    if "deadline" in data:
        value = data["deadline"] or None
        if value is not None and not valid_date(value):
            return err("Invalid date.")
        changes["deadline"] = value
        changes["date_certain"] = 1 if value else 0      # the student has confirmed it
        if value is None:
            changes["deadline_time"] = None
    if "deadline_time" in data and "deadline_time" not in changes:
        value = data["deadline_time"] or None
        if value is not None and not valid_time(value):
            return err("Invalid time.")
        changes["deadline_time"] = value

    if changes:
        cols = ", ".join(f"{c} = ?" for c in changes)      # column names come from the list above only
        db.execute(f"UPDATE tasks SET {cols} WHERE id = ? AND user_id = ?",
                   [*changes.values(), task_id, uid()])
        db.commit()
    updated = db.execute(TASK_SELECT + "WHERE t.id = ? AND t.user_id = ?", (task_id, uid())).fetchone()
    return jsonify(task_dict(updated))


@app.delete("/api/tasks/<int:task_id>")
@login_required
def delete_task(task_id):
    db = get_db()
    cur = db.execute("DELETE FROM tasks WHERE id = ? AND user_id = ?", (task_id, uid()))
    db.commit()
    if cur.rowcount == 0:
        return err("Task not found.", 404)
    return jsonify(ok=True)


@app.get("/api/calendar")
@login_required
def calendar():
    month = request.args.get("month", "")
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        return err("Month must look like 2026-11.")
    rows = get_db().execute(
        TASK_SELECT + "WHERE t.user_id = ? AND t.deadline LIKE ? "
        "ORDER BY t.deadline, t.deadline_time, t.id",
        (uid(), month + "-%"),
    ).fetchall()
    return jsonify([task_dict(r) for r in rows])


@app.get("/api/dashboard")
@login_required
def dashboard():
    db = get_db()
    today = date.today()
    soon = (today + timedelta(days=reminder_days(uid()))).isoformat()
    week = (today + timedelta(days=7)).isoformat()

    def tasks_where(condition, *args):
        rows = db.execute(
            TASK_SELECT + "WHERE t.user_id = ? AND t.status = 'pending' AND " + condition +
            " ORDER BY t.deadline IS NULL, t.deadline, t.deadline_time, t.id", (uid(), *args)
        ).fetchall()
        return [task_dict(r) for r in rows]

    counts = db.execute(
        "SELECT SUM(status = 'pending') AS pending, SUM(status = 'completed') AS completed "
        "FROM tasks WHERE user_id = ?", (uid(),)
    ).fetchone()
    total_notices = db.execute("SELECT COUNT(*) AS c FROM notices WHERE user_id = ?", (uid(),)).fetchone()["c"]

    return jsonify(
        total_notices=total_notices,
        pending=counts["pending"] or 0,
        completed=counts["completed"] or 0,
        urgent=tasks_where("(t.priority = 'urgent' OR (t.deadline IS NOT NULL AND t.deadline <= ?))", soon),
        upcoming=tasks_where("t.deadline IS NOT NULL AND t.deadline >= ? AND t.deadline <= ?",
                             today.isoformat(), week),
        overdue=tasks_where("t.deadline IS NOT NULL AND t.deadline < ?", today.isoformat()),
        conflicts=conflicts_for(uid()),
    )


# ----------------------------------------------------------------------------
# JSON errors instead of HTML pages
# ----------------------------------------------------------------------------
@app.errorhandler(404)
def not_found(_e):
    return err("Not found.", 404)


@app.errorhandler(405)
def bad_method(_e):
    return err("Method not allowed.", 405)


@app.errorhandler(413)
def too_large(_e):
    return err("That file is too large (10 MB maximum).", 413)


@app.errorhandler(500)
def server_error(_e):
    return err("Server error. Check the terminal running app.py.", 500)


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True)
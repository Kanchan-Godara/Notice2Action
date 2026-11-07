"""app.py - the Flask server. It defines the API endpoints the frontend calls.
Run with:  python backend/app.py   then open http://127.0.0.1:5000"""
import os
import sys
from datetime import date, timedelta
from flask import Flask, jsonify, request, send_from_directory

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config
from database import init_db, query, execute
from services.pdf_service import NoticeError, validate_pdf, extract_pdf_text, clean_text
from services.rule_extractor import extract_with_rules
from services.ai_service import AIError, ai_available, extract_with_ai, simplify_notice, LANGUAGES
from services.conflict_service import detect_conflicts

app = Flask(__name__, static_folder=config.FRONTEND_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = config.MAX_PDF_BYTES + 1024 * 1024
try:                                   # CORS is only needed if the frontend is served elsewhere
    from flask_cors import CORS
    CORS(app)
except ImportError:
    pass

PRIORITIES = ("low", "medium", "high", "urgent")
STATUSES = ("pending", "completed")
SETTING_KEYS = ("student_name", "language", "reminder_days")


# ---------- helpers ----------
def err(message, code=400):
    return jsonify({"error": message}), code


def valid_date(value):
    try:
        date.fromisoformat(value)
        return True
    except (TypeError, ValueError):
        return False


def all_tasks():
    return query("""SELECT t.*, n.title AS notice_title FROM tasks t
                    JOIN notices n ON n.id = t.notice_id
                    ORDER BY t.deadline IS NULL, t.deadline, t.deadline_time""")


@app.errorhandler(NoticeError)
def handle_notice_error(e):
    return err(str(e))


@app.errorhandler(413)
def too_large(e):
    return err(f"File is too large. Maximum size is {config.MAX_PDF_MB} MB.", 413)


@app.errorhandler(Exception)
def handle_unexpected(e):
    app.logger.exception(e)
    return err("Something went wrong on the server.", 500)


# ---------- pages & status ----------
@app.route("/")
def home():
    index = os.path.join(config.FRONTEND_DIR, "index.html")
    if os.path.exists(index):
        return send_from_directory(config.FRONTEND_DIR, "index.html")
    return jsonify({"app": "Notice2Action API", "note": "Frontend not built yet."})


@app.route("/api/status")
def status():
    # Reports ONLY whether AI is configured. The key itself is never sent.
    return jsonify({"ai_available": ai_available(), "model": config.GEMINI_MODEL if ai_available() else None,
                    "languages": list(LANGUAGES)})


# ---------- notices ----------
@app.route("/api/notices", methods=["POST"])
def create_notice():
    """Accept a PDF (multipart 'file') or pasted text (JSON {'text','title'}), analyse, save."""
    if "file" in request.files:
        f = request.files["file"]
        data = f.read()
        validate_pdf(f.filename or "", data)
        text, pages = extract_pdf_text(data)
        meta = dict(source_type="pdf", filename=f.filename, file_size=len(data), page_count=pages)
        title = (request.form.get("title") or f.filename.rsplit(".", 1)[0]).strip()
    else:
        body = request.get_json(silent=True) or {}
        text = clean_text(body.get("text") or "")
        if len(text) < 20:
            return err("Please paste at least a few sentences of the notice.")
        meta = dict(source_type="text", filename=None, file_size=len(text), page_count=None)
        title = (body.get("title") or text.split("\n")[0]).strip()
    title = title[:80] or "Untitled notice"

    # Analyse: AI first (if configured), otherwise rules. Tell the user which was used.
    ai_warning, result = None, None
    if ai_available():
        try:
            result = extract_with_ai(text)
        except AIError as e:
            ai_warning = f"{e} Used rule-based extraction instead."
    if result is None:
        result = extract_with_rules(text)

    notice_id = execute(
        "INSERT INTO notices (title, source_type, filename, file_size, page_count, raw_text, summary, method)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (title, meta["source_type"], meta["filename"], meta["file_size"], meta["page_count"],
         text, result["summary"], result["method"]))
    for t in result["tasks"]:
        execute("INSERT INTO tasks (notice_id,title,description,deadline,deadline_time,date_certain,"
                "priority,source_sentence,source_verified) VALUES (?,?,?,?,?,?,?,?,?)",
                (notice_id, t["title"], t["description"], t["deadline"], t["deadline_time"],
                 t["date_certain"], t["priority"], t["source_sentence"], t["source_verified"]))
    return jsonify({**get_notice_data(notice_id), "ai_warning": ai_warning}), 201


def get_notice_data(notice_id):
    rows = query("SELECT * FROM notices WHERE id=?", (notice_id,))
    if not rows:
        return None
    tasks = query("SELECT * FROM tasks WHERE notice_id=? ORDER BY deadline IS NULL, deadline", (notice_id,))
    return {"notice": rows[0], "tasks": tasks,
            "conflicts": [c for c in detect_conflicts(tasks)]}


@app.route("/api/notices", methods=["GET"])
def list_notices():
    return jsonify(query("""SELECT n.id, n.title, n.source_type, n.filename, n.file_size, n.page_count,
        n.method, n.created_at, (SELECT COUNT(*) FROM tasks WHERE notice_id=n.id) AS task_count
        FROM notices n ORDER BY n.id DESC"""))


@app.route("/api/notices/<int:nid>")
def get_notice(nid):
    data = get_notice_data(nid)
    return jsonify(data) if data else err("Notice not found.", 404)


@app.route("/api/notices/<int:nid>", methods=["DELETE"])
def delete_notice(nid):
    execute("DELETE FROM notices WHERE id=?", (nid,))      # tasks removed by ON DELETE CASCADE
    return jsonify({"deleted": nid})


@app.route("/api/notices/<int:nid>/simplify", methods=["POST"])
def simplify(nid):
    rows = query("SELECT raw_text FROM notices WHERE id=?", (nid,))
    if not rows:
        return err("Notice not found.", 404)
    language = ((request.get_json(silent=True) or {}).get("language") or "english").lower()
    if language not in LANGUAGES:
        return err("Language must be english, hindi or punjabi.")
    if not ai_available():
        return err("Simple Language Mode needs an AI key. Add GEMINI_API_KEY to your .env file "
                   "and restart the server.", 503)
    try:
        return jsonify({"language": language, "explanation": simplify_notice(rows[0]["raw_text"], language)})
    except AIError as e:
        return err(str(e), 502)


# ---------- tasks ----------
@app.route("/api/tasks")
def list_tasks():
    sql, params = ["SELECT t.*, n.title AS notice_title FROM tasks t JOIN notices n ON n.id=t.notice_id WHERE 1=1"], []
    for col, allowed in (("priority", PRIORITIES), ("status", STATUSES)):
        value = request.args.get(col)
        if value in allowed:
            sql.append(f"AND t.{col}=?")
            params.append(value)
    if request.args.get("notice_id", "").isdigit():
        sql.append("AND t.notice_id=?")
        params.append(int(request.args["notice_id"]))
    # sort=deadline (soonest first, no-date tasks last) or newest
    sql.append("ORDER BY t.id DESC" if request.args.get("sort") == "newest"
               else "ORDER BY t.deadline IS NULL, t.deadline, t.deadline_time")
    return jsonify(query(" ".join(sql), params))


@app.route("/api/tasks/<int:tid>", methods=["PATCH"])
def update_task(tid):
    """Edit any of: title, description, deadline, deadline_time, priority, status."""
    body = request.get_json(silent=True) or {}
    fields, params = [], []
    if "title" in body:
        if not str(body["title"]).strip():
            return err("Title cannot be empty.")
        fields.append("title=?"); params.append(str(body["title"]).strip()[:150])
    if "description" in body:
        fields.append("description=?"); params.append(str(body["description"])[:1000])
    if "deadline" in body:
        if body["deadline"] and not valid_date(body["deadline"]):
            return err("Deadline must look like YYYY-MM-DD.")
        fields += ["deadline=?", "date_certain=1"]      # student confirmed it, so it is no longer a guess
        params.append(body["deadline"] or None)
    if "deadline_time" in body:
        fields.append("deadline_time=?"); params.append(body["deadline_time"] or None)
    if "priority" in body:
        if body["priority"] not in PRIORITIES:
            return err("Invalid priority.")
        fields.append("priority=?"); params.append(body["priority"])
    if "status" in body:
        if body["status"] not in STATUSES:
            return err("Invalid status.")
        fields.append("status=?"); params.append(body["status"])
    if not fields:
        return err("Nothing to update.")
    if not query("SELECT id FROM tasks WHERE id=?", (tid,)):
        return err("Task not found.", 404)
    execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id=?", (*params, tid))
    return jsonify(query("SELECT * FROM tasks WHERE id=?", (tid,))[0])


@app.route("/api/tasks/<int:tid>", methods=["DELETE"])
def delete_task(tid):
    execute("DELETE FROM tasks WHERE id=?", (tid,))
    return jsonify({"deleted": tid})


# ---------- dashboard, calendar, settings ----------
@app.route("/api/dashboard")
def dashboard():
    tasks = all_tasks()
    today = date.today()
    pending = [t for t in tasks if t["status"] == "pending"]
    soon = (today + timedelta(days=7)).isoformat()
    upcoming = [t for t in pending if t["deadline"] and today.isoformat() <= t["deadline"] <= soon]
    return jsonify({
        "total_notices": query("SELECT COUNT(*) AS c FROM notices")[0]["c"],
        "pending": len(pending),
        "completed": len(tasks) - len(pending),
        "upcoming": upcoming,
        "urgent": [t for t in pending if t["priority"] == "urgent"],
        "overdue": [t for t in pending if t["deadline"] and t["deadline"] < today.isoformat()],
        "conflicts": detect_conflicts(tasks),
    })


@app.route("/api/calendar")
def calendar():
    month = request.args.get("month")                       # optional 'YYYY-MM'
    tasks = [t for t in all_tasks() if t["deadline"] and (not month or t["deadline"].startswith(month))]
    return jsonify(tasks)


@app.route("/api/settings", methods=["GET", "PUT"])
def settings():
    if request.method == "PUT":
        body = request.get_json(silent=True) or {}
        if body.get("language", "english") not in LANGUAGES:
            return err("Unsupported language.")
        for key in SETTING_KEYS:
            if key in body:
                execute("INSERT INTO settings (key,value) VALUES (?,?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(body[key])[:100]))
    saved = {r["key"]: r["value"] for r in query("SELECT * FROM settings")}
    return jsonify({"student_name": saved.get("student_name", ""), "language": saved.get("language", "english"),
                    "reminder_days": saved.get("reminder_days", "2")})


init_db()
if __name__ == "__main__":
   app.run(debug=True, port=5001)
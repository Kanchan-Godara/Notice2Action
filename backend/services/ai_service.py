"""ai_service.py - optional AI features using Google's Gemini API (free tier).
The key stays on the server (environment variable). If anything fails we raise AIError
and the app falls back to rule_extractor. We use urllib, so no extra library is needed."""
import json
import re
import urllib.error
import urllib.request
from datetime import date
import config


class AIError(Exception):
    pass


def ai_available():
    return bool(config.GEMINI_API_KEY)


def _call_gemini(prompt, want_json):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{config.GEMINI_MODEL}:generateContent"
    body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.1}}
    if want_json:
        body["generationConfig"]["responseMimeType"] = "application/json"
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers={
        "Content-Type": "application/json", "x-goog-api-key": config.GEMINI_API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.load(resp)
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except urllib.error.HTTPError as e:
        raise AIError(f"AI service error (HTTP {e.code}). Check your API key and quota.")
    except (urllib.error.URLError, TimeoutError):
        raise AIError("Could not reach the AI service (network problem).")
    except (KeyError, IndexError, ValueError):
        raise AIError("The AI service returned an unexpected response.")


def _norm(s):
    return re.sub(r"\s+", " ", s or "").strip().lower()


def extract_with_ai(text, today=None):
    """Ask the AI for structured tasks, then CHECK every source sentence against the notice."""
    today = today or date.today()
    prompt = f"""You extract student tasks from a college notice. Today's date is {today.isoformat()}.
Return ONLY JSON: {{"summary": string, "tasks": [{{"title": string, "description": string,
"deadline": "YYYY-MM-DD" or null, "deadline_time": "HH:MM" or null, "date_certain": true/false,
"priority": "low"|"medium"|"high"|"urgent", "source_sentence": string}}]}}
Rules:
- Use ONLY information written in the notice. Never invent dates, rooms, fees or tasks.
- "source_sentence" must be copied EXACTLY, word for word, from the notice.
- If the year is not stated, guess nothing: set date_certain=false. If no date, deadline=null.
- priority "urgent" only if the deadline is within 2 days of today.
- If the notice has no tasks, return an empty tasks list.
NOTICE:
\"\"\"{text}\"\"\""""
    raw = _call_gemini(prompt, want_json=True)
    try:
        data = json.loads(raw)
        items = data.get("tasks", [])
    except (ValueError, AttributeError):
        raise AIError("The AI did not return valid JSON.")
    norm_text = _norm(text)
    tasks = []
    for t in items:
        if not isinstance(t, dict) or not str(t.get("title", "")).strip():
            continue
        src = str(t.get("source_sentence") or "").strip()
        verified = bool(src) and _norm(src) in norm_text   # real check, not trust
        deadline = t.get("deadline")
        try:
            date.fromisoformat(deadline)
        except (TypeError, ValueError):
            deadline = None
        priority = t.get("priority") if t.get("priority") in ("low", "medium", "high", "urgent") else "medium"
        tasks.append({
            "title": str(t["title"]).strip()[:150],
            "description": str(t.get("description") or "").strip(),
            "deadline": deadline,
            "deadline_time": t.get("deadline_time") if re.fullmatch(r"\d{2}:\d{2}", str(t.get("deadline_time"))) else None,
            "date_certain": 1 if (deadline and t.get("date_certain", True)) else 0,
            "priority": priority,
            "source_sentence": src if verified else None,
            "source_verified": 1 if verified else 0,
        })
    return {"summary": str(data.get("summary") or ""), "tasks": tasks, "method": "ai"}


LANGUAGES = {"english": "simple English", "hindi": "simple Hindi (Devanagari script)",
             "punjabi": "simple Punjabi (Gurmukhi script)"}


def simplify_notice(text, language="english"):
    """Explain a notice in plain language while keeping every date/number unchanged."""
    if language not in LANGUAGES:
        raise AIError("Unsupported language.")
    prompt = f"""Explain this college notice to a first-year student in {LANGUAGES[language]}.
Use short sentences and bullet points. Copy all dates, times, amounts, names and room numbers
EXACTLY as written. Do not add any information that is not in the notice.
NOTICE:
\"\"\"{text}\"\"\""""
    return _call_gemini(prompt, want_json=False).strip()
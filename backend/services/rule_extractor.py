"""rule_extractor.py - FALLBACK analysis that works with no AI and no internet.

How it works (simple version):
  1. Split the notice into sentences.
  2. In each sentence look for dates (regex + dateparser), times, and action words.
  3. If a sentence looks like something a student must DO, make a task from it.
Every task keeps the exact sentence it came from, so nothing is invented.
"""
import re
from datetime import date, datetime
import dateparser

MONTHS = (r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
          r"sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)")
DATE_PATTERNS = [
    r"\b\d{4}-\d{2}-\d{2}\b",                                              # 2026-11-15
    r"\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b",                              # 15/11/2026
    rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s+(?:of\s+)?{MONTHS}\b\.?(?:,?\s+\d{{4}})?",   # 15th Nov 2026
    rf"\b{MONTHS}\b\.?\s+\d{{1,2}}(?:st|nd|rd|th)?\b(?:,?\s+\d{{4}})?",           # Nov 15, 2026
]
ACTION = re.compile(
    r"\b(submit\w*|regist\w+|apply|applic\w+|pay\w*|deposit\w*|fees?|attend\w*|report\w*|collect\w*|"
    r"bring|carry|fill\w*|upload\w*|complete\w*|appear\w*|enrol\w*|exams?|examinations?|tests?|viva|"
    r"assignments?|projects?|deadline|last date|due|verify|verification|download\w*|forms?)\b", re.I)
REQUIREMENT = re.compile(r"\b(must|mandatory|compulsory|required|should|need to|have to)\b", re.I)
URGENT_WORDS = re.compile(r"(last date|last day|mandatory|compulsory|penalty|late fee|fine of|"
                          r"will not be (accepted|entertained)|strictly|final (date|chance))", re.I)
CATEGORIES = [
    (r"exam|test|viva", "Exam / test"),
    (r"submit|assignment|project|upload", "Submission"),
    (r"regist|enrol|apply|applic", "Registration"),
    (r"\bpay|fee|deposit", "Fee payment"),
    (r"attend|report|appear|meet", "Attendance"),
]
RANGE_WORDS = re.compile(r"\b(to|till|until|through|between|from|last date|deadline|before|by)\b", re.I)


def split_sentences(text):
    """Split into sentences. Each returned sentence is an exact piece of the input."""
    out = []
    for block in text.split("\n"):
        block = block.strip()
        if not block:
            continue
        # don't split after common abbreviations such as "Dr." or "Rs."
        parts = re.split(r"(?<!\bDr)(?<!\bMr)(?<!\bMrs)(?<!\bMs)(?<!\bProf)(?<!\bRs)(?<!\bNo)"
                         r"(?<=[.!?])\s+(?=[A-Z0-9])", block)
        out += [p.strip() for p in parts if p.strip()]
    return out


def parse_date_text(text, today):
    """Turn matched date text into (ISO date, is_certain). Missing year => uncertain."""
    iso = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", text)
    if iso:
        try:
            return date(int(iso[1]), int(iso[2]), int(iso[3])).isoformat(), True
        except ValueError:
            return None
    has_year = bool(re.search(r"\d{4}", text)) or bool(re.fullmatch(r"\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2}", text))
    cleaned = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", text, flags=re.I)
    cleaned = re.sub(r"\bof\b", "", cleaned, flags=re.I)
    dt = dateparser.parse(cleaned, settings={
        "DATE_ORDER": "DMY", "PREFER_DATES_FROM": "future",
        "RELATIVE_BASE": datetime(today.year, today.month, today.day)})
    if not dt:
        return None
    return dt.date().isoformat(), has_year


def find_dates(sentence, today):
    """Return all dates found in a sentence, in order of appearance."""
    found, taken = [], []
    for pattern in DATE_PATTERNS:
        for m in re.finditer(pattern, sentence, re.I):
            if any(m.start() < e and s < m.end() for s, e in taken):
                continue                      # already matched by another pattern
            parsed = parse_date_text(m.group(0), today)
            if parsed:
                taken.append((m.start(), m.end()))
                found.append({"pos": m.start(), "iso": parsed[0], "certain": parsed[1], "text": m.group(0)})
    return sorted(found, key=lambda d: d["pos"])


def find_time(sentence):
    """Return the first clock time as 'HH:MM', or None."""
    m = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b", sentence, re.I)
    if m:
        hour, minute = int(m[1]) % 12, int(m[2] or 0)
        if m[3].lower() == "p":
            hour += 12
        return f"{hour:02d}:{minute:02d}" if hour < 24 and minute < 60 else None
    m = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", sentence)
    return f"{int(m[1]):02d}:{m[2]}" if m else None


def pick_priority(deadline_iso, sentence, today):
    """Priority from how close the deadline is and from warning words."""
    urgent_word = bool(URGENT_WORDS.search(sentence))
    if deadline_iso:
        days = (date.fromisoformat(deadline_iso) - today).days
        if 0 <= days <= 2:
            return "urgent"
        if days < 0 or days <= 7 or urgent_word:
            return "high"
        return "medium"
    return "high" if urgent_word else "low"


def short_title(sentence):
    s = re.sub(r"^([-•*●▪]|\d+[.)])\s*", "", sentence).strip()
    return s if len(s) <= 90 else s[:87].rsplit(" ", 1)[0] + "…"


def extract_with_rules(text, today=None):
    today = today or date.today()
    sentences = split_sentences(text)
    tasks = []
    for sentence in sentences:
        dates = find_dates(sentence, today)
        has_action = bool(ACTION.search(sentence))
        is_task = (dates and has_action) or (has_action and REQUIREMENT.search(sentence))
        if not is_task:
            continue
        chosen = None
        if dates:
            # for ranges ("from 10 Nov to 15 Nov") the LAST date is the real deadline
            chosen = dates[-1] if (len(dates) > 1 or RANGE_WORDS.search(sentence)) else dates[0]
        label = next((name for pat, name in CATEGORIES if re.search(pat, sentence, re.I)), "Action")
        notes = [f"Type: {label}."]
        if len(dates) > 1:
            notes.append("Dates mentioned: " + ", ".join(d["text"] for d in dates) + ".")
        if chosen and not chosen["certain"]:
            notes.append("Year not stated in the notice - date is uncertain, please verify.")
        if not chosen:
            notes.append("No date found in the notice for this task.")
        tasks.append({
            "title": short_title(sentence),
            "description": " ".join(notes),
            "deadline": chosen["iso"] if chosen else None,
            "deadline_time": find_time(sentence),
            "date_certain": 1 if (chosen and chosen["certain"]) else 0,
            "priority": pick_priority(chosen["iso"] if chosen else None, sentence, today),
            "source_sentence": sentence,
            "source_verified": 1,             # copied directly from the text
        })
    preview = " ".join(sentences[:2])[:300]
    return {"summary": preview, "tasks": tasks, "method": "rules"}
"""conflict_service.py - find deadline clashes WITHOUT crying wolf.
 * 'conflict'  = two timed tasks on the same day less than 60 minutes apart (definite).
 * 'busy_day'  = 3+ pending tasks due on one day (just a heads-up, not a clash)."""
from collections import defaultdict

CLASH_MINUTES = 60
BUSY_DAY_COUNT = 3


def _minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def detect_conflicts(tasks):
    by_date = defaultdict(list)
    for t in tasks:
        if t["status"] == "pending" and t.get("deadline"):
            by_date[t["deadline"]].append(t)
    alerts = []
    for day, group in sorted(by_date.items()):
        timed = [t for t in group if t.get("deadline_time")]
        for i in range(len(timed)):
            for j in range(i + 1, len(timed)):
                a, b = timed[i], timed[j]
                if abs(_minutes(a["deadline_time"]) - _minutes(b["deadline_time"])) < CLASH_MINUTES:
                    alerts.append({"level": "conflict", "date": day, "task_ids": [a["id"], b["id"]],
                                   "message": f'"{a["title"]}" and "{b["title"]}" are due within an hour of each other.'})
        if len(group) >= BUSY_DAY_COUNT:
            unsure = any(not t.get("date_certain") for t in group)
            alerts.append({"level": "busy_day", "date": day, "task_ids": [t["id"] for t in group],
                           "message": f"{len(group)} tasks are due on this day. Not a definite clash, "
                                      f"but plan ahead." + (" Some dates are uncertain." if unsure else "")})
    return alerts
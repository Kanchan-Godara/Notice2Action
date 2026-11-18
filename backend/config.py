"""config.py - All settings live here, so other files never hard-code paths or keys."""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "notice2action.db")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

MAX_PDF_MB = 10
MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024
MAX_TEXT_CHARS = 30000          # limit for pasted text / extracted PDF text


def _load_env_file():
    """Tiny .env reader (so beginners don't need python-dotenv)."""
    path = os.path.join(BASE_DIR, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())


_load_env_file()
# Secrets are read ONLY on the server. The frontend never sees them.
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
# Secret key used to secure user login sessions.
SECRET_KEY = os.environ.get("SECRET_KEY") or os.urandom(32)
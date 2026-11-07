"""pdf_service.py - validate PDFs, extract text with PyMuPDF, and clean the text."""
import re
from config import MAX_PDF_BYTES, MAX_PDF_MB, MAX_TEXT_CHARS


class NoticeError(Exception):
    """An error whose message is safe to show to the student."""


def validate_pdf(filename, data):
    """Check extension, size and the real PDF signature (not just the name)."""
    if not filename.lower().endswith(".pdf"):
        raise NoticeError("Only PDF files are allowed.")
    if len(data) == 0:
        raise NoticeError("The file is empty.")
    if len(data) > MAX_PDF_BYTES:
        raise NoticeError(f"File is too large. Maximum size is {MAX_PDF_MB} MB.")
    if not data.startswith(b"%PDF"):
        raise NoticeError("This file is not a valid PDF.")


def extract_pdf_text(data):
    """Return (text, page_count). Raises NoticeError for unreadable/scanned PDFs."""
    import fitz  # PyMuPDF
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception:
        raise NoticeError("Could not open this PDF. It may be corrupted or password-protected.")
    pages = [page.get_text() for page in doc]
    count = len(pages)
    doc.close()
    text = clean_text("\n".join(pages))
    if len(text) < 20:
        raise NoticeError("No readable text found. This looks like a scanned image PDF "
                          "(OCR is not supported yet). Please paste the text instead.")
    return text, count


def clean_text(text):
    """Join lines wrapped mid-sentence, keep paragraph/bullet breaks.
    The cleaned text is what we store AND search, so source sentences stay exact."""
    text = text.replace("\r", "\n").replace("\u00a0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    out = []
    for ln in (l.strip() for l in text.split("\n")):
        if not ln:
            out.append("")
        elif out and out[-1] and not re.search(r"[.:;!?]$", out[-1]) \
                and not re.match(r"^([-•*●▪]|\d+[.)])\s", ln):
            out[-1] += " " + ln          # continuation of the previous line
        else:
            out.append(ln)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()[:MAX_TEXT_CHARS]
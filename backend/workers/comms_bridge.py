"""
Phase 8 — Email & Calendar bridge (DRAFT-ONLY, OS-aware).

Hard invariant: this module NEVER sends mail or saves a calendar event. Every
path opens a draft/compose window (or a pre-filled web page / .ics confirm
dialog) that the user must review and submit manually. No SMTP, no send API, no
stored credentials.

Providers:
  gmail       — opens a pre-filled compose / Google Calendar template URL in the
                default browser. Cross-platform, inherently draft-only.
  apple_mail  — macOS osascript: a visible UNSENT outgoing message. Calendar via
                a generated .ics opened in Calendar (user confirms the import).
  outlook     — macOS osascript / Windows PowerShell COM .Display(): an unsent
                compose window. Calendar via .ics.

`list_providers()` returns only the providers valid for the current OS, with
gmail always included.
"""

import os
import platform
import tempfile
import subprocess
import webbrowser
from datetime import datetime
from urllib.parse import quote, urlencode


def list_providers():
    system = platform.system()
    if system == "Darwin":
        return ["apple_mail", "outlook", "gmail"]
    if system == "Windows":
        return ["outlook", "gmail"]
    # Linux / other — only the browser path is reliable.
    return ["gmail"]


# ----------------------------------------------------------------------------
# Date helpers — accept ISO / "YYYY-MM-DDTHH:MM" (datetime-local) and emit the
# Google Calendar / iCalendar compact UTC-ish stamp.
# ----------------------------------------------------------------------------
def _parse_dt(s):
    if not s:
        return None
    s = s.strip().replace("Z", "")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _stamp(dt):
    return dt.strftime("%Y%m%dT%H%M%S")


# ----------------------------------------------------------------------------
# Gmail / Google Calendar URLs (browser, draft-only).
# ----------------------------------------------------------------------------
def _gmail_mail_url(to, subject, body):
    q = urlencode({"view": "cm", "fs": "1", "to": to or "", "su": subject or "", "body": body or ""},
                  quote_via=quote)
    return "https://mail.google.com/mail/?" + q


def _gcal_url(title, body, start, end, location):
    sd, ed = _parse_dt(start), _parse_dt(end)
    params = {"action": "TEMPLATE", "text": title or "", "details": body or "", "location": location or ""}
    if sd and ed:
        params["dates"] = f"{_stamp(sd)}/{_stamp(ed)}"
    elif sd:
        params["dates"] = f"{_stamp(sd)}/{_stamp(sd)}"
    return "https://calendar.google.com/calendar/render?" + urlencode(params, quote_via=quote)


# ----------------------------------------------------------------------------
# AppleScript / PowerShell escaping + execution.
# ----------------------------------------------------------------------------
def _osa_escape(s):
    return (s or "").replace("\\", "\\\\").replace('"', '\\"')


def _run_osascript(script):
    subprocess.run(["osascript", "-e", script], check=False, timeout=20)


def _apple_mail_draft(to, subject, body):
    s, b, t = _osa_escape(subject), _osa_escape(body), _osa_escape(to)
    script = f'''
tell application "Mail"
    set newMessage to make new outgoing message with properties {{subject:"{s}", content:"{b}", visible:true}}
    tell newMessage
        make new to recipient at end of to recipients with properties {{address:"{t}"}}
    end tell
    activate
end tell'''
    _run_osascript(script)


def _outlook_mac_draft(to, subject, body):
    s, b, t = _osa_escape(subject), _osa_escape(body), _osa_escape(to)
    script = f'''
tell application "Microsoft Outlook"
    set newMessage to make new outgoing message with properties {{subject:"{s}", content:"{b}"}}
    tell newMessage
        make new recipient with properties {{email address:{{address:"{t}"}}}}
    end tell
    open newMessage
    activate
end tell'''
    _run_osascript(script)


def _outlook_win_draft(to, subject, body):
    def esc(x):
        return (x or "").replace("'", "''")
    ps = (
        "$o = New-Object -ComObject Outlook.Application; "
        "$m = $o.CreateItem(0); "
        f"$m.To = '{esc(to)}'; $m.Subject = '{esc(subject)}'; $m.Body = '{esc(body)}'; "
        "$m.Display()"  # opens the unsent compose window; never .Send()
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=False, timeout=20)


# ----------------------------------------------------------------------------
# .ics generation for native calendar draft (opens a confirm dialog).
# ----------------------------------------------------------------------------
def _write_ics(title, body, start, end, location):
    sd, ed = _parse_dt(start), _parse_dt(end)
    now = datetime.now()
    summary = (title or "").replace("\n", " ")
    desc = (body or "").replace("\n", "\\n")  # iCal folds newlines as literal \n
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Cortex//Utilities//EN",
        "METHOD:PUBLISH", "BEGIN:VEVENT",
        f"UID:{now.strftime('%Y%m%dT%H%M%S')}@cortex",
        f"DTSTAMP:{_stamp(now)}",
        f"SUMMARY:{summary}",
    ]
    if sd:
        lines.append(f"DTSTART:{_stamp(sd)}")
    if ed:
        lines.append(f"DTEND:{_stamp(ed)}")
    elif sd:
        lines.append(f"DTEND:{_stamp(sd)}")
    if body:
        lines.append(f"DESCRIPTION:{desc}")
    if location:
        lines.append(f"LOCATION:{location}")
    lines += ["END:VEVENT", "END:VCALENDAR"]
    fd, path = tempfile.mkstemp(suffix=".ics", prefix="cortex_event_")
    with os.fdopen(fd, "w") as f:
        f.write("\r\n".join(lines))
    return path


def _open_native(path):
    system = platform.system()
    if system == "Darwin":
        subprocess.run(["open", path], check=False, timeout=20)
    elif system == "Windows":
        os.startfile(path)  # type: ignore[attr-defined]
    else:
        subprocess.run(["xdg-open", path], check=False, timeout=20)


# ----------------------------------------------------------------------------
# Public entry point.
# ----------------------------------------------------------------------------
def make_draft(provider, kind, fields):
    """Stage a draft. Returns a dict describing what happened. Never sends.

    For gmail → {"mode": "browser", "url": ...} (frontend opens it).
    For native providers → opens the draft here and returns {"mode": "native"}.
    """
    to = fields.get("to", "")
    subject = fields.get("subject", "")
    body = fields.get("body", "")
    title = fields.get("subject") or fields.get("title") or ""
    start = fields.get("start", "")
    end = fields.get("end", "")
    location = fields.get("location", "")

    if provider == "gmail":
        url = _gmail_mail_url(to, subject, body) if kind == "mail" \
            else _gcal_url(title, body, start, end, location)
        return {"status": "success", "mode": "browser", "url": url}

    system = platform.system()
    if kind == "mail":
        if provider == "apple_mail" and system == "Darwin":
            _apple_mail_draft(to, subject, body)
        elif provider == "outlook" and system == "Darwin":
            _outlook_mac_draft(to, subject, body)
        elif provider == "outlook" and system == "Windows":
            _outlook_win_draft(to, subject, body)
        else:
            # Unsupported native combo on this OS → fall back to Gmail browser.
            return {"status": "success", "mode": "browser",
                    "url": _gmail_mail_url(to, subject, body),
                    "note": f"{provider} unavailable on {system}; opened Gmail compose instead."}
        return {"status": "success", "mode": "native"}

    # kind == "event" → native calendar via .ics confirm dialog
    path = _write_ics(title, body, start, end, location)
    _open_native(path)
    return {"status": "success", "mode": "native", "ics": path}

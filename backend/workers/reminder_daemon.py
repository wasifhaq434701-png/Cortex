"""
Phase 8 — background reminder daemon for the Notes & Tasks canvas.

A single daemon thread wakes every ~30s, finds reminders whose `due_at` has
arrived, and fires a NATIVE OS desktop notification (osascript on macOS,
PowerShell toast on Windows, notify-send on Linux). One-shot reminders are then
marked `fired=1`; cron reminders reschedule by advancing `due_at` to their next
matching minute.

All writes go through `task_queue.submit` so the single-writer invariant holds.
Reads are direct (WAL allows concurrent readers). No third-party deps — the cron
matcher is a tiny stdlib implementation supporting "m h dom mon dow".
"""

import time
import shutil
import platform
import threading
import subprocess
from datetime import datetime, timedelta

from backend.database import get_db_connection
from backend.workers.task_queue import submit

_POLL_SECONDS = 30
_thread = None
_lock = threading.Lock()


# ----------------------------------------------------------------------------
# Tiny cron matcher — fields: minute hour day-of-month month day-of-week
# Supports  *  a  a-b  a-b/n  */n  a,b,c  (dow: 0/7 = Sunday)
# ----------------------------------------------------------------------------
def _parse_field(spec, lo, hi):
    allowed = set()
    for part in spec.split(","):
        part = part.strip()
        step = 1
        if "/" in part:
            rng, step_s = part.split("/", 1)
            step = int(step_s)
        else:
            rng = part
        if rng == "*":
            start, end = lo, hi
        elif "-" in rng:
            a, b = rng.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(rng)
        for v in range(start, end + 1, step):
            allowed.add(v)
    return allowed


def _cron_matches(cron_str, dt):
    try:
        m, h, dom, mon, dow = cron_str.split()
    except ValueError:
        return False
    mins = _parse_field(m, 0, 59)
    hours = _parse_field(h, 0, 23)
    doms = _parse_field(dom, 1, 31)
    mons = _parse_field(mon, 1, 12)
    dows = _parse_field(dow, 0, 7)
    # Python: Monday=0..Sunday=6 → cron: Sunday=0..Saturday=6
    cron_dow = (dt.weekday() + 1) % 7
    dow_ok = cron_dow in dows or (cron_dow == 0 and 7 in dows)
    if dt.minute not in mins or dt.hour not in hours or dt.month not in mons:
        return False
    # Standard cron: when both dom and dow are restricted, match on EITHER.
    dom_restricted = dom.strip() != "*"
    dow_restricted = dow.strip() != "*"
    if dom_restricted and dow_restricted:
        return dt.day in doms or dow_ok
    return (dt.day in doms) and dow_ok


def cron_next(cron_str, after_ts):
    """Return the unix ts of the next minute matching cron_str after after_ts,
    or None if no match within a year (malformed expression)."""
    start = datetime.fromtimestamp(after_ts).replace(second=0, microsecond=0) + timedelta(minutes=1)
    for i in range(366 * 24 * 60):
        dt = start + timedelta(minutes=i)
        if _cron_matches(cron_str, dt):
            return dt.timestamp()
    return None


# ----------------------------------------------------------------------------
# Native desktop notification (OS-aware, best-effort).
# ----------------------------------------------------------------------------
def fire_notification(title, body):
    title = (title or "Cortex Reminder").replace('"', "'")
    body = (body or "").replace('"', "'")
    system = platform.system()
    try:
        if system == "Darwin":
            script = f'display notification "{body}" with title "{title}" sound name "Glass"'
            subprocess.run(["osascript", "-e", script], check=False, timeout=10)
        elif system == "Windows":
            # Prefer BurntToast; fall back to a Forms balloon (no install needed).
            ps = (
                f"if (Get-Module -ListAvailable -Name BurntToast) {{ "
                f"New-BurntToastNotification -Text '{title}', '{body}' }} else {{ "
                f"Add-Type -AssemblyName System.Windows.Forms; "
                f"$n = New-Object System.Windows.Forms.NotifyIcon; "
                f"$n.Icon = [System.Drawing.SystemIcons]::Information; "
                f"$n.Visible = $true; "
                f"$n.ShowBalloonTip(10000, '{title}', '{body}', 'Info') }}"
            )
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=False, timeout=10)
        else:
            if shutil.which("notify-send"):
                subprocess.run(["notify-send", title, body], check=False, timeout=10)
    except Exception as e:
        print(f"⏰ [Reminder] notification failed: {e}")


# ----------------------------------------------------------------------------
# Poll loop.
# ----------------------------------------------------------------------------
def _due_reminders(now):
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT id, title, body, cron FROM tasks
               WHERE kind = 'reminder' AND fired = 0
                 AND due_at IS NOT NULL AND due_at <= ?""",
            (now,),
        )
        return cur.fetchall()
    finally:
        conn.close()


def _backfill_cron_due(now):
    """Cron reminders created without an initial due_at get one computed."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """SELECT id, cron FROM tasks
               WHERE kind = 'reminder' AND fired = 0
                 AND cron IS NOT NULL AND cron != '' AND due_at IS NULL"""
        )
        rows = cur.fetchall()
    finally:
        conn.close()
    for rid, cron in rows:
        nxt = cron_next(cron, now)
        if nxt:
            submit("update", {"id": rid, "due_at": nxt})


def _tick():
    now = time.time()
    _backfill_cron_due(now)
    for rid, title, body, cron in _due_reminders(now):
        fire_notification(title, body)
        if cron:
            nxt = cron_next(cron, now)
            if nxt:
                submit("update", {"id": rid, "due_at": nxt})
            else:
                submit("update", {"id": rid, "fired": 1})  # bad cron → stop
        else:
            submit("update", {"id": rid, "fired": 1})


def _run():
    print("⏰ [Reminder] daemon started")
    while True:
        try:
            _tick()
        except Exception as e:
            print(f"⏰ [Reminder] tick error: {e}")
        time.sleep(_POLL_SECONDS)


def start_reminder_daemon():
    """Launch the daemon thread once. Idempotent."""
    global _thread
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _thread = threading.Thread(target=_run, name="reminder-daemon", daemon=True)
        _thread.start()

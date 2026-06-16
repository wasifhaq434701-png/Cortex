"""
Phase 8 — single-writer serializer for the SQLite `tasks` / `compare_votes`
tables.

Every WRITE goes through one daemon thread draining a `queue.Queue`, so there is
never more than one writer touching these tables at a time. This sidesteps
SQLite write-lock contention (`database is locked`) without pulling in Redis or
Celery — pure stdlib, in keeping with the zero-dependency, one-click-install
goal. Reads stay direct: WAL mode already allows concurrent readers.

Public API:
    start_task_queue()                  # idempotent; launches the worker thread
    submit(op, payload, timeout=10.0)   # enqueue a write, block for its result
"""

import time
import queue
import threading
from concurrent.futures import Future

from backend.database import get_db_connection

# (op:str, payload:dict, future:Future)
_q: "queue.Queue" = queue.Queue()
_worker = None
_lock = threading.Lock()


# ----------------------------------------------------------------------------
# Write operations — all run on the single worker thread, one connection.
# ----------------------------------------------------------------------------
def _op_create(cur, p):
    now = time.time()
    cur.execute(
        """INSERT INTO tasks (kind, title, body, done, due_at, cron, fired, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)""",
        (p.get("kind", "task"), p.get("title", ""), p.get("body", ""),
         1 if p.get("done") else 0, p.get("due_at"), p.get("cron"), now, now),
    )
    return {"id": cur.lastrowid}


def _op_update(cur, p):
    fields, vals = [], []
    for col in ("kind", "title", "body", "done", "due_at", "cron", "fired"):
        if col in p:
            fields.append(f"{col} = ?")
            v = p[col]
            if col in ("done", "fired"):
                v = 1 if v else 0
            vals.append(v)
    if not fields:
        return {"updated": 0}
    fields.append("updated_at = ?")
    vals.append(time.time())
    vals.append(p["id"])
    cur.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?", vals)
    return {"updated": cur.rowcount}


def _op_delete(cur, p):
    cur.execute("DELETE FROM tasks WHERE id = ?", (p["id"],))
    return {"deleted": cur.rowcount}


def _op_record_vote(cur, p):
    cur.execute(
        """INSERT INTO compare_votes (prompt, model_a, model_b, winner, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (p.get("prompt", ""), p.get("model_a", ""), p.get("model_b", ""),
         p.get("winner", ""), time.time()),
    )
    return {"id": cur.lastrowid}


_OPS = {
    "create": _op_create,
    "update": _op_update,
    "delete": _op_delete,
    "record_vote": _op_record_vote,
}


def _run():
    """Worker loop: own one connection, drain the queue, fulfil each Future."""
    conn = get_db_connection()
    while True:
        op, payload, fut = _q.get()
        try:
            handler = _OPS.get(op)
            if handler is None:
                raise ValueError(f"unknown task-queue op: {op}")
            cur = conn.cursor()
            result = handler(cur, payload)
            conn.commit()
            if fut is not None and not fut.cancelled():
                fut.set_result(result)
        except Exception as e:  # never let one bad op kill the writer
            try:
                conn.rollback()
            except Exception:
                pass
            if fut is not None and not fut.cancelled():
                fut.set_exception(e)
        finally:
            _q.task_done()


def start_task_queue():
    """Launch the worker thread once. Safe to call repeatedly (idempotent)."""
    global _worker
    with _lock:
        if _worker is not None and _worker.is_alive():
            return
        _worker = threading.Thread(target=_run, name="task-queue-writer", daemon=True)
        _worker.start()
        print("🗒️  [TaskQueue] single-writer thread started")


def submit(op, payload, timeout=10.0):
    """Enqueue a write op and block until the worker finishes it.

    Returns the op's result dict, or raises whatever the worker raised.
    """
    if _worker is None or not _worker.is_alive():
        start_task_queue()
    fut: Future = Future()
    _q.put((op, payload, fut))
    return fut.result(timeout=timeout)

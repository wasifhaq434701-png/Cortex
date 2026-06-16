import sqlite3
import os
import hashlib
from typing import List, Dict

# Abstract storage directory via environment variable
STORAGE_DIR = os.environ.get("MINDPALACE_STORAGE_DIR", os.path.join(os.path.dirname(__file__), "storage"))
os.makedirs(STORAGE_DIR, exist_ok=True)
DB_PATH = os.path.join(STORAGE_DIR, "cache.db")

def get_db_connection():
    """Initializes and returns a SQLite connection with WAL mode enabled to prevent locking collisions."""
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn

def init_db():
    """Initializes the required tables for incremental diff caching."""
    conn = get_db_connection()
    cursor = conn.cursor()
    # file_cache maps a file path and project ID to its SHA-256 hash.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS file_cache (
            project_id TEXT,
            file_path TEXT,
            sha256_hash TEXT,
            last_modified REAL,
            PRIMARY KEY (project_id, file_path)
        )
    """)
    # Phase 8 — Utilities Studio. `tasks` backs the Notes & Tasks canvas and the
    # reminder daemon (kind = 'note' | 'task' | 'reminder'). due_at is a unix ts
    # for one-shot reminders; cron is a 5-field "m h dom mon dow" string for
    # repeating ones; fired marks one-shots already alerted.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL DEFAULT 'task',
            title TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            done INTEGER NOT NULL DEFAULT 0,
            due_at REAL,
            cron TEXT,
            fired INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL DEFAULT 0
        )
    """)
    # Phase 8 — Model Compare blind-test results.
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS compare_votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt TEXT NOT NULL DEFAULT '',
            model_a TEXT NOT NULL DEFAULT '',
            model_b TEXT NOT NULL DEFAULT '',
            winner TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL DEFAULT 0
        )
    """)
    conn.commit()
    conn.close()

def compute_sha256(file_path: str) -> str:
    """Computes the SHA-256 hash of a file."""
    sha256_hash = hashlib.sha256()
    try:
        with open(file_path, "rb") as f:
            for byte_block in iter(lambda: f.read(4096), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    except Exception:
        return ""

def scan_incremental(project_id: str, files: List[str]) -> Dict[str, List[str]]:
    """
    Scans a list of files against the SQLite diff-cache.
    Returns a dict with 'modified' (or new) files, and 'unchanged' files.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    
    modified_files = []
    unchanged_files = []
    
    # Pre-fetch existing hashes for the project
    cursor.execute("SELECT file_path, sha256_hash FROM file_cache WHERE project_id = ?", (project_id,))
    existing_hashes = {row[0]: row[1] for row in cursor.fetchall()}
    
    for file_path in files:
        if not os.path.exists(file_path):
            continue
            
        current_hash = compute_sha256(file_path)
        current_mtime = os.path.getmtime(file_path)
        
        if file_path not in existing_hashes or existing_hashes[file_path] != current_hash:
            modified_files.append(file_path)
            # Update the cache
            cursor.execute("""
                INSERT OR REPLACE INTO file_cache (project_id, file_path, sha256_hash, last_modified)
                VALUES (?, ?, ?, ?)
            """, (project_id, file_path, current_hash, current_mtime))
        else:
            unchanged_files.append(file_path)
            
    conn.commit()
    conn.close()
    
    return {
        "modified": modified_files,
        "unchanged": unchanged_files
    }

def get_orphaned_files(project_id: str, current_files: List[str]) -> List[str]:
    """Finds files in the cache that no longer exist in the provided current_files list."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT file_path FROM file_cache WHERE project_id = ?", (project_id,))
    cached_files = [row[0] for row in cursor.fetchall()]
    conn.close()
    
    current_files_set = set(current_files)
    orphaned = [f for f in cached_files if f not in current_files_set]
    return orphaned

def cascading_delete(project_id: str, file_paths: List[str]):
    """Removes files from the SQLite diff-cache. (ChromaDB cleanup is handled separately)."""
    if not file_paths:
        return
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Delete in chunks to avoid SQLite limits on variables
    chunk_size = 500
    for i in range(0, len(file_paths), chunk_size):
        chunk = file_paths[i:i + chunk_size]
        placeholders = ",".join("?" * len(chunk))
        params = [project_id] + chunk
        cursor.execute(f"DELETE FROM file_cache WHERE project_id = ? AND file_path IN ({placeholders})", params)
        
    conn.commit()
    conn.close()

# Initialize the schema on load
init_db()

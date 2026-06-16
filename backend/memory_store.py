import os
import logging
import threading

# mem0 logs benign warnings on every import/add — "chroma does not support
# keyword search" (hybrid BM25 disabled) and "spaCy is not installed". Neither
# is an error (semantic search works; spaCy is an optional NLP extra we
# deliberately don't ship to keep the env light + cross-platform), but they look
# alarming in the terminal during Import Vault. Quiet them to ERROR.
for _noisy in ("mem0", "mem0.vector_stores.chroma", "chromadb"):
    logging.getLogger(_noisy).setLevel(logging.ERROR)

from mem0 import Memory
from backend.database import STORAGE_DIR

# Initialize Mem0 client backed by SQLite
MEM0_DB_PATH = os.path.join(STORAGE_DIR, "mem0.db")

# ---------------------------------------------------------------------------
# Cached Memory clients. mem0's HuggingFace embedder loads a torch model on
# every `Memory.from_config()`. FastAPI runs the sync /api/memory/* endpoints
# in a worker-thread pool, and loading a torch model off the main thread can
# raise "Cannot copy out of meta tensor" on torch 2.x. Building the client ONCE
# (warmed on the main thread at startup, see warmup_memory) and reusing it both
# eliminates that crash and avoids reloading the embedder on every request.
# ---------------------------------------------------------------------------
_clients = {}
_clients_lock = threading.Lock()
# mem0's torch embedder is NOT thread-safe: concurrent first-use across FastAPI
# worker threads (e.g. a background memory-extraction thread racing a Settings
# GET) corrupts the model onto the `meta` device. Serialize EVERY mem0 operation
# through one lock — memory calls are infrequent, so the cost is negligible.
_op_lock = threading.RLock()


def _resolve_model(model_name: str = None):
    """Pick a usable Ollama model for mem0's fact-extraction LLM: honor an
    explicit non-default choice, else the first installed model, else the
    hardcoded default. (get/delete don't need the LLM; add/import do.)"""
    if model_name and model_name != "llama3.2:latest":
        return model_name
    try:
        import requests
        r = requests.get("http://localhost:11434/api/tags", timeout=3)
        names = [m["name"] for m in r.json().get("models", [])]
        if names:
            return names[0]
    except Exception:
        pass
    return "llama3.2:latest"


def _get_client(model_name: str = None):
    # Always resolve to a model the user actually has (never a hardcoded name).
    model_name = _resolve_model(model_name)
    with _clients_lock:
        client = _clients.get(model_name)
        if client is None:
            client = Memory.from_config(_get_dynamic_config(model_name))
            _clients[model_name] = client
        return client


def warmup_memory(model_name: str = None):
    """Pre-build the default Memory client AND force its embedder's torch model to
    fully materialize on the calling (main) thread. mem0's HF embedder lazily
    moves the model off the `meta` device on the first embed call; if that first
    call happens in a FastAPI worker thread it raises "Cannot copy out of meta
    tensor". Running a throwaway search here materializes it on the main thread so
    every later request just reuses the loaded model. Non-fatal on failure."""
    try:
        with _op_lock:
            client = _get_client(model_name)
            # Force a real embedding pass (search embeds the query) to pull the
            # model off the meta device now, on this thread.
            try:
                client.search("warmup", user_id="__warmup__", limit=1)
            except Exception:
                pass
        return True
    except Exception as e:
        print(f"⚠️  [Memory] warmup failed: {e}")
        return False


def _get_dynamic_config(model_name: str = "llama3.2:latest"):
    return {
        "vector_store": {
            "provider": "chroma",
            "config": {
                "collection_name": "user_memory",
                "path": os.path.join(STORAGE_DIR, "mem0_chroma")
            }
        },
        "embedder": {
            "provider": "huggingface",
            "config": {
                "model": "sentence-transformers/all-MiniLM-L6-v2"
            }
        },
        "llm": {
            "provider": "ollama",
            "config": {
                "model": model_name,
            }
        }
    }

def process_memory_extraction(user_query: str, ai_response: str, user_id: str = "default_user", active_model_name: str = None):
    """
    Background hook to parse conversations and extract memory facts.
    Includes a Redundancy Guard to only invoke embedding if specific personal context keys are found.
    """
        
    # Mem0 Embedding Redundancy Guard
    trigger_phrases = ["I prefer", "My project", "We are building", "I like", "My name is", "I want to", "Please remember", "Keep in mind", "I use"]
    
    should_extract = False
    query_lower = user_query.lower()
    for phrase in trigger_phrases:
        if phrase.lower() in query_lower:
            should_extract = True
            break
            
    if not should_extract:
        print("Mem0 Guard: No personal context keys detected. Skipping extraction to save resources.")
        return
        
    print("Mem0 Guard: Personal context detected. Extracting memories...")
    
    try:
        with _op_lock:
            memory_client = _get_client(active_model_name)
            messages = [
                {"role": "user", "content": user_query},
                {"role": "assistant", "content": ai_response}
            ]
            memory_client.add(messages, user_id=user_id)
        print("Mem0: Memory extraction complete.")
    except Exception as e:
        print(f"Mem0 Extraction Error: {e}")

def get_memories(user_id: str = "default_user"):
    try:
        with _op_lock:
            memory_client = _get_client()
            res = memory_client.get_all(filters={"user_id": user_id})
        # Handle dict response from newer mem0 versions
        if isinstance(res, dict):
            if "results" in res:
                return res["results"]
            if "memories" in res:
                return res["memories"]
        if isinstance(res, list):
            return res
        return []
    except Exception as e:
        print(f"Mem0 Get Error: {e}")
        return []

def delete_memory(memory_id: str):
    try:
        with _op_lock:
            memory_client = _get_client()
            memory_client.delete(memory_id)
    except Exception as e:
        print(f"Mem0 Delete Error: {e}")

def add_manual_memory(content: str, user_id: str = "default_user"):
    try:
        with _op_lock:
            memory_client = _get_client(_resolve_model())
            memory_client.add([{"role": "user", "content": content}], user_id=user_id)
    except Exception as e:
        print(f"Mem0 Add Error: {e}")

def get_core_directives(user_id: str = "default_user") -> str:
    """Layer 1: Persistent Core Directives from Mem0 SQLite."""
    try:
        memories = get_memories(user_id=user_id)
        if not memories:
            return ""
        directives = []
        for m in memories:
            if isinstance(m, dict):
                if "memory" in m: directives.append(m["memory"])
                elif "content" in m: directives.append(m["content"])
                elif "text" in m: directives.append(m["text"])
            elif isinstance(m, str):
                directives.append(m)
        if not directives:
            return ""
        # Cap the directives block so a large imported memory vault can't bloat
        # every prompt (it's prepended to all chat context).
        block = "Global Rules & Directives:\n" + "\n".join(f"- {d}" for d in directives)
        return block[:1500]
    except Exception as e:
        print(f"Error fetching core directives: {e}")
        return ""

def compact_session_history(history: list, active_model: str) -> list:
    """
    Layer 4: Working Memory Compaction
    Tier A (Zero-LLM Fast Path): Heuristic slicing and truncation.
    """
    compacted = []
    for msg in history:
        if not isinstance(msg, dict):
            compacted.append(msg)
            continue
            
        role = msg.get("role", "")
        content = msg.get("content", "")
        
        if isinstance(content, str):
            # Tier A: Truncate long terminal stdout or large tool output to strictly the last 500 characters
            if len(content) > 500 and (role in ("user", "tool", "assistant")):
                truncated_content = content[-500:]
                content = f"[Truncated for VRAM Optimization]... {truncated_content}"
                
        new_msg = dict(msg)
        new_msg["content"] = content
        compacted.append(new_msg)
        
    return compacted

import os
import io
import csv
import shutil
import tempfile
import asyncio
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from fastapi import FastAPI, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from fastapi import WebSocket, WebSocketDisconnect, Query
from pydantic import BaseModel
from typing import Optional

# Web Search
from duckduckgo_search import DDGS

# --- CORE APPLICATION IMPORTS ---
from backend.parser import process_directory
from backend.embeddings import generate_embeddings, semantic_search
from backend.clusters import calculate_coordinates_and_clusters
from backend.ai_client import generate_cluster_titles, run_contextual_chat, generate_hyde_document


from backend.ppt_generator import create_ppt_from_session, get_available_themes
from backend.pdf_generator import create_pdf_from_session
from backend.database import scan_incremental, get_orphaned_files, cascading_delete
from backend.parser import get_all_files, process_files
from backend.workers.predictive_engine import run_predictive_analytics
import multiprocessing
import threading
import uuid

# Multiprocessing shared memory dictionary for AirLLM tasks
manager = multiprocessing.Manager()
airllm_tasks = manager.dict()
airllm_queue = multiprocessing.Queue()

from backend.workers.airllm_worker import airllm_worker_loop
worker_process = multiprocessing.Process(target=airllm_worker_loop, args=(airllm_queue, airllm_tasks), daemon=True)
worker_process.start()

# Phase 8 — Utilities Studio background threads (single-writer queue + reminders)
from backend.workers.task_queue import start_task_queue, submit as task_submit
from backend.workers.reminder_daemon import start_reminder_daemon, cron_next
from backend.database import get_db_connection

# ==========================================
# Data Models
# ==========================================
class ProcessRequest(BaseModel):
    directory_path: str
    project_id: str = "default"
    ai_provider: str = "local"
    api_key: str = ""

class ChatRequest(BaseModel):
    question: str
    node_content: str
    ai_provider: str = "local"
    api_key: str = ""

class SearchRequest(BaseModel):
    query: str
    ai_provider: str = "local"
    api_key: str = ""
    project_id: str = "default"

class PredictiveRequest(BaseModel):
    data_matrix: list
    visualize_active: bool = True

class DeepAnalysisRequest(BaseModel):
    prompt: str
    model_repo: str = ""
    project_id: str = "default"

class ClusterTitleRequest(BaseModel):
    ai_provider: str = "local"
    api_key: str = ""

class WebSearchRequest(BaseModel):
    query: str
    max_results: int = 8

class PPTExportRequest(BaseModel):
    sessionId: str
    projectName: str = "Cortex"
    sessionName: str = "Analysis Report"
    modelUsed: str = "local"
    theme: str = "dark"
    customTheme: str = ""
    slideCount: int = 10
    messages: list  # List of {"narrative": str, "charts": list}

class PDFExportRequest(BaseModel):
    sessionId: str
    projectName: str = "Cortex"
    sessionName: str = "Analysis Report"
    modelUsed: str = "local"
    messages: list

class CSVExportRequest(BaseModel):
    sessionId: str
    messages: list = []   # Each message may have charts with tabular data
    csvText: str = ""     # Verbatim CSV table extracted from the AI response


# ==========================================
# App Initialization
# ==========================================
app = FastAPI(title="Cortex Engine")

# Define paths relative to project root
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# Global application state to store mapped nodes for search execution
APP_STATE = {"nodes": []}


@app.on_event("startup")
def _start_utilities_daemons():
    """Phase 8 — launch the task-queue writer + reminder daemon once. Both
    start_* helpers are idempotent (no-op if their thread is already alive), so
    this is safe under uvicorn --reload."""
    start_task_queue()
    start_reminder_daemon()
    # Build the mem0 client once on the main thread so its embedder's torch model
    # is materialized before any worker-thread /api/memory request (prevents the
    # "Cannot copy out of meta tensor" crash + avoids per-request model reloads).
    try:
        from backend.memory_store import warmup_memory
        warmup_memory()
    except Exception as _e:
        print(f"⚠️  [startup] memory warmup skipped: {_e}")


# ==========================================
# Model Discovery
# ==========================================
@app.get("/api/local-models")
def get_local_models():
    """Fetches all installed Ollama models from the local daemon registry."""
    try:
        response = requests.get("http://localhost:11434/api/tags", timeout=3)
        if response.status_code == 200:
            models_data = response.json().get("models", [])
            model_names = [model["name"] for model in models_data]
            return {"status": "success", "models": model_names}
    except requests.exceptions.ConnectionError:
        return {"status": "error", "message": "Ollama daemon not running", "models": []}
    except Exception as e:
        return {"status": "error", "message": str(e), "models": []}


# ==========================================
# Core API Routes
# ==========================================
@app.post("/api/process")
async def process_data(request: ProcessRequest):
    """Returns the 3D map instantly using incremental caching."""
    print(f"Ingesting directory: {request.directory_path} via {request.ai_provider.upper()} for project {request.project_id}")
    
    # 1. Get all file paths in the requested directory
    all_files = get_all_files(request.directory_path)
    if not all_files:
        return {"error": "No valid readable files found.", "nodes": []}
    
    # 2. Check incremental diff cache
    diff_results = scan_incremental(request.project_id, all_files)
    modified_files = diff_results["modified"]
    
    # 3. Handle Dangling Nodes (Cascading Delete)
    orphaned_files = get_orphaned_files(request.project_id, all_files)
    if orphaned_files:
        print(f"🗑 Purging {len(orphaned_files)} orphaned files from diff-cache and ChromaDB")
        cascading_delete(request.project_id, orphaned_files)
        from backend.embeddings import purge_orphaned_nodes
        purge_orphaned_nodes(request.project_id, orphaned_files)
    
    # 4. Only process modified files
    if modified_files:
        print(f"⚡ Processing {len(modified_files)} new/modified files (bypassing {len(diff_results['unchanged'])} unchanged files)")
        parsed_data = process_files(modified_files)
        
        if parsed_data:
            # We pass append=True because we are only upserting incremental updates
            embedded_data = generate_embeddings(parsed_data, append=True, project_id=request.project_id)
            calculate_coordinates_and_clusters(embedded_data)
            
            # Note: calculate_coordinates_and_clusters modifies embedded_data in place
            # However, APP_STATE['nodes'] needs to have ALL nodes for the UI.
            # Wait, calculate_coordinates_and_clusters needs all nodes to cluster correctly.
            # For Phase 4, we will fetch all vectors from ChromaDB to send to the UI.
    else:
        print("⚡ No files modified. Serving directly from cache.")
        
    # 5. Fetch ALL current nodes from ChromaDB to send to the UI
    from backend.embeddings import get_collection_for_project
    collection = get_collection_for_project(request.project_id)
    all_docs = collection.get(include=["metadatas", "documents", "embeddings"])
    
    final_data = []
    if all_docs and "ids" in all_docs and all_docs["ids"]:
        for i, doc_id in enumerate(all_docs["ids"]):
            meta = all_docs["metadatas"][i]
            final_data.append({
                "id": doc_id,
                "content": all_docs["documents"][i],
                "source_file": meta.get("source_file", ""),
                "cluster_id": meta.get("cluster_id", 0),
                "embedding": all_docs["embeddings"][i] if (all_docs.get("embeddings") is not None and len(all_docs["embeddings"]) > i) else []
            })
    
    # Re-calculate coordinates for the whole graph so it renders correctly
    if final_data:
        final_data = calculate_coordinates_and_clusters(final_data)
        
        # Strip out the dense vector arrays before sending to the frontend
        # This prevents FastAPI jsonable_encoder crashes on NumPy float32s and saves massive network bandwidth
        for node in final_data:
            node.pop("embedding", None)
    
    APP_STATE["nodes"] = final_data
    
    # Build placeholder titles instantly so the map renders NOW
    cluster_groups = {}
    for node in final_data:
        cid = node.get("cluster_id", 0)
        if cid not in cluster_groups:
            cluster_groups[cid] = []
        cluster_groups[cid].append(node.get("source_file", "unknown"))
    
    # Instant placeholder titles (file-count based)
    placeholder_titles = {}
    for cid, files in cluster_groups.items():
        unique = list(set(files))
        placeholder_titles[str(cid)] = f"Cluster ({len(unique)} files)"
    
    # Store cluster info for async title generation
    APP_STATE["cluster_groups"] = cluster_groups
    APP_STATE["last_provider"] = request.ai_provider
    APP_STATE["last_api_key"] = request.api_key
    
    return {"nodes": final_data, "cluster_titles": placeholder_titles}


def _smallest_local_model():
    """Return the installed Ollama model with the smallest parameter size (by the
    NUMBERbB tag), or None. Used to keep background work off the heavy chat model."""
    try:
        import requests as _rq
        r = _rq.get("http://127.0.0.1:11434/api/tags", timeout=3)
        names = [m["name"] for m in r.json().get("models", [])]
        if not names:
            return None
        def _size(name):
            m = re.search(r'(\d+(?:\.\d+)?)[bB]', name)
            return float(m.group(1)) if m else 999.0
        return sorted(names, key=_size)[0]
    except Exception:
        return None


@app.post("/api/cluster-titles")
async def get_cluster_titles(request: ClusterTitleRequest):
    """Generates AI-powered cluster titles asynchronously after the map has rendered."""
    cluster_groups = APP_STATE.get("cluster_groups", {})
    if not cluster_groups:
        return {"cluster_titles": {}}
    
    provider = request.ai_provider or APP_STATE.get("last_provider", "local")
    api_key = request.api_key or APP_STATE.get("last_api_key", "")

    # Cluster-title generation is non-critical background work. If the active
    # model is a heavy local one (e.g. a 27B), running titles on it serializes
    # behind / blocks the user's chat on Ollama for minutes. Route titles to the
    # SMALLEST installed local model instead so the chat model stays free.
    if isinstance(provider, str) and provider.startswith("local:"):
        small = _smallest_local_model()
        if small:
            provider = f"local:{small}"

    # ONE batched LLM call for ALL clusters (single model load + one generation,
    # vs one call per cluster). Short timeout + instant heuristic fallback inside
    # the helper, so mapping never hangs even on a slow model.
    from backend.ai_client import generate_cluster_titles_batch
    loop = asyncio.get_event_loop()
    titles = await loop.run_in_executor(
        None, lambda: generate_cluster_titles_batch(cluster_groups, provider, api_key, 90)
    )
    return {"cluster_titles": titles}


# /api/chat is deprecated and replaced by /api/brain/ws


@app.post("/api/web-search")
async def web_search(request: WebSearchRequest):
    """Performs a real web search via DuckDuckGo and returns results."""
    print(f"🌐 Web Search for: '{request.query}'")
    try:
        with DDGS() as ddgs:
            raw_results = list(ddgs.text(request.query, max_results=request.max_results))
        
        results = []
        for r in raw_results:
            results.append({
                "title": r.get("title", ""),
                "body": r.get("body", ""),
                "href": r.get("href", "")
            })
        
        print(f"   Found {len(results)} web results")
        return {"results": results}
    except Exception as e:
        print(f"   Web search error: {e}")
        return {"results": [], "error": str(e)}

@app.post("/api/search")
async def search_universe(request: SearchRequest):
    """Performs a mathematical semantic vector search across the active universe."""
    print(f"Executing Global Vector Search for query: '{request.query}'")
    
    # ---------------------------------------------------------
    # ADVANCED RAG (HyDE - Phase 3)
    # ---------------------------------------------------------
    print("Synthesizing Hypothetical Document (HyDE)...")
    hyde_doc = generate_hyde_document(
        query=request.query, 
        provider=request.ai_provider, 
        api_key=request.api_key
    )
    
    results = semantic_search(request.query, hyde_doc=hyde_doc, project_id=request.project_id)
    return {"results": results}


@app.post("/api/upload")
async def upload_chat_file(file: UploadFile = File(...)):
    """Receives a file directly from chat, parses it, and dynamically injects it into memory."""
    print(f"Dynamically injecting {file.filename} into Agent Memory...")
    
    # Save the uploaded file to a temporary location
    temp_dir = tempfile.mkdtemp()
    file_path = os.path.join(temp_dir, file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    # Process just this single file
    parsed_data = process_directory(file_path)
    if not parsed_data:
        shutil.rmtree(temp_dir)
        return {"error": "Could not extract readable text from this file."}
    
    # Capture the raw extracted text BEFORE embedding (for direct context injection)
    extracted_content = "\n\n".join([chunk.get("content", "") for chunk in parsed_data])
    
    # Embed with APPEND mode so existing search vectors are preserved!
    embedded_data = generate_embeddings(parsed_data, append=True)
    APP_STATE["nodes"].extend(embedded_data)
    
    # Recalculate the 3D space so the new file pops into the universe!
    final_data = calculate_coordinates_and_clusters(APP_STATE["nodes"])
    APP_STATE["nodes"] = final_data
    
    # Clean up temp file
    shutil.rmtree(temp_dir)
    
    return {
        "message": "Success",
        "nodes": final_data,
        "extracted_content": extracted_content,
        "filename": file.filename
    }


@app.get("/api/browse")
def browse_local_system(type: str = "folder"):
    """Bypasses browser security to open a native macOS Finder dialog safely."""
    import platform
    import subprocess
    
    try:
        if platform.system() == "Darwin":
            if type == "file":
                script = 'POSIX path of (choose file with prompt "Select a File to Map")'
            else:
                script = 'POSIX path of (choose folder with prompt "Select a Folder to Map")'
                
            result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
            selected_path = result.stdout.strip()
            
            return {"path": selected_path}
            
        else:
            import tkinter as tk
            from tkinter import filedialog
            
            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            
            if type == "file":
                selected_path = filedialog.askopenfilename(parent=root, title="Select a File")
            else:
                selected_path = filedialog.askdirectory(parent=root, title="Select a Folder")
                
            root.destroy()
            return {"path": selected_path}
            
    except Exception as e:
        return {"error": str(e)}


# ==========================================
# Generative Studio Eport Routes
# ==========================================
@app.get("/api/pptx-themes")
def list_ppt_themes():
    """Returns all available PPT presentation themes for the frontend dropdown."""
    return {"themes": get_available_themes()}


@app.post("/api/export-pptx")
async def export_session_as_ppt(request: PPTExportRequest):
    """Generates and returns a themed .pptx file from session chat messages."""
    try:
        print(f"Generating PPT for session: {request.sessionId} (Theme: {request.theme})")
        
        session_data = {
            "projectName": request.projectName,
            "sessionName": request.sessionName,
            "modelUsed": request.modelUsed,
            "theme": request.theme,
            "customTheme": request.customTheme,
            "slideCount": request.slideCount,
            "messages": request.messages
        }
        
        ppt_buffer = create_ppt_from_session(session_data)
        
        return StreamingResponse(
            ppt_buffer,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            headers={
                "Content-Disposition": f'attachment; filename="cortex-{request.sessionId}.pptx"'
            }
        )
    except Exception as e:
        print(f"PPT generation error: {e}")
        return {"error": str(e)}


@app.post("/api/export-pdf")
async def export_session_as_pdf(request: PDFExportRequest):
    """Generates and returns a styled PDF report from session chat messages."""
    try:
        print(f"Generating PDF for session: {request.sessionId}")
        
        session_data = {
            "projectName": request.projectName,
            "sessionName": request.sessionName,
            "modelUsed": request.modelUsed,
            "messages": request.messages
        }
        
        pdf_buffer = create_pdf_from_session(session_data)
        
        return StreamingResponse(
            pdf_buffer,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="cortex-{request.sessionId}.pdf"'
            }
        )
    except Exception as e:
        print(f"PDF generation error: {e}")
        return {"error": str(e)}


@app.post("/api/export-csv")
async def export_session_as_csv(request: CSVExportRequest):
    """Exports chart data from session messages as a CSV file."""
    try:
        print(f"Generating CSV for session: {request.sessionId}")

        # Preferred path: the model returned a tabular block (Markdown table or
        # CSV). Normalize into aligned CSV: parse rows, pad/truncate every row to
        # the header's column count, then re-emit with correct quoting.
        if request.csvText and request.csvText.strip():
            raw = request.csvText.strip()
            rows = []
            if "|" in raw and re.search(r'^\s*\|.*\|\s*$', raw, re.M):
                # Markdown table → split on pipes, drop the |---| separator row.
                for line in raw.splitlines():
                    line = line.strip()
                    if not line.startswith("|"):
                        continue
                    if re.match(r'^\|?[\s:|-]+\|?$', line):  # separator row
                        continue
                    cells = [c.strip() for c in line.strip().strip("|").split("|")]
                    rows.append(cells)
            else:
                rows = [r for r in csv.reader(io.StringIO(raw)) if any(c.strip() for c in r)]

            if rows:
                ncols = len(rows[0])
                norm = io.StringIO()
                w = csv.writer(norm)
                for r in rows:
                    r = (r + [""] * ncols)[:ncols]  # pad short / truncate long
                    w.writerow(r)
                csv_bytes = io.BytesIO(norm.getvalue().encode("utf-8"))
                csv_bytes.seek(0)
                return StreamingResponse(
                    csv_bytes,
                    media_type="text/csv",
                    headers={
                        "Content-Disposition": f'attachment; filename="cortex-{request.sessionId}.csv"'
                    }
                )

        output = io.StringIO()
        writer = csv.writer(output)

        # Write header
        writer.writerow(["Section", "Chart Title", "Category", "Value"])
        
        for msg_idx, msg in enumerate(request.messages):
            charts = msg.get('charts', [])
            narrative = msg.get('narrative', '')
            
            for chart in charts:
                chart_title = chart.get('label', f'Chart {msg_idx + 1}')
                labels = chart.get('labels', [])
                data = chart.get('data', [])
                
                for label, value in zip(labels, data):
                    writer.writerow([f"Analysis {msg_idx + 1}", chart_title, label, value])
            
            # If no charts but narrative exists, include as text row
            if not charts and narrative:
                writer.writerow([f"Analysis {msg_idx + 1}", "Narrative", "", narrative[:200]])
        
        csv_bytes = io.BytesIO(output.getvalue().encode('utf-8'))
        csv_bytes.seek(0)
        
        return StreamingResponse(
            csv_bytes,
            media_type="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="cortex-{request.sessionId}.csv"'
            }
        )
    except Exception as e:
        print(f"CSV generation error: {e}")
        return {"error": str(e)}

# ==========================================
# Phase 4: Headless Workers & Queues
# ==========================================
@app.post("/api/predictive-analytics")
async def api_predictive_analytics(request: PredictiveRequest):
    """Headless API for processing numerical matrices and returning chart coordinates."""
    result = run_predictive_analytics(request.data_matrix, request.visualize_active)
    if "error" in result:
        return {"error": result["error"]}
    return result

@app.post("/api/generate-deep-analysis")
async def generate_deep_analysis(request: DeepAnalysisRequest):
    """Submits a long-running PDF/PPT generation task to the AirLLM worker queue."""
    task_id = str(uuid.uuid4())
    
    # Initialize task state
    airllm_tasks[task_id] = {"status": "queued", "progress": 0, "result": None}
    
    # Send to worker process
    airllm_queue.put({
        "task_id": task_id,
        "prompt": request.prompt,
        "model_repo": request.model_repo
    })
    
    return {"status": "accepted", "task_id": task_id}

@app.get("/api/deep-analysis-status/{task_id}")
async def deep_analysis_status(task_id: str):
    """Polling endpoint for the frontend to check AirLLM status."""
    if task_id not in airllm_tasks:
        return {"error": "Task not found."}
        
    task_info = airllm_tasks[task_id]
    return task_info

# ==========================================
# Phase 5: Voice and Memory Endpoints
# ==========================================
class VoiceTranscribeRequest(BaseModel):
    # Depending on how frontend sends it, we might use FileUpload instead.
    pass

from fastapi import Form
from backend.workers.voice_worker import transcribe_audio

@app.post("/api/voice/transcribe")
async def transcribe_voice(audio: UploadFile = File(...)):
    """Receives an audio file, transcribes it via Whisper worker, and returns text."""
    try:
        import uuid
        filename = audio.filename or "recording.webm"
        ext = filename.split('.')[-1] if '.' in filename else 'webm'
        temp_audio_path = os.path.join(tempfile.gettempdir(), f"voice_{uuid.uuid4().hex}.{ext}")
        
        with open(temp_audio_path, "wb") as f:
            f.write(await audio.read())
            
        # Run transcription in a thread to avoid blocking
        loop = asyncio.get_running_loop()
        text = await loop.run_in_executor(None, transcribe_audio, temp_audio_path)
        
        # Cleanup
        if os.path.exists(temp_audio_path):
            os.remove(temp_audio_path)
            
        return {"text": text}
    except Exception as e:
        return {"error": str(e)}

class MemoryAddRequest(BaseModel):
    content: str
    
class MemoryDeleteRequest(BaseModel):
    memory_id: str

@app.get("/api/memory/get")
def api_get_memory():
    from backend.memory_store import get_memories
    return {"memories": get_memories()}

@app.post("/api/memory/add")
def api_add_memory(request: MemoryAddRequest):
    from backend.memory_store import add_manual_memory
    add_manual_memory(request.content)
    return {"status": "success"}

class MemoryImportRequest(BaseModel):
    payload: str

@app.post("/api/memory/import")
def api_import_memory(request: MemoryImportRequest):
    from backend.memory_store import add_manual_memory
    # The add_manual_memory function takes a string and passes it to mem0.add()
    # mem0 will automatically extract and chunk the facts from the large payload.
    add_manual_memory(request.payload)
    return {"status": "success"}

@app.post("/api/memory/delete")
def api_delete_memory(request: MemoryDeleteRequest):
    from backend.memory_store import delete_memory
    delete_memory(request.memory_id)
    return {"status": "success"}

def _graphrag_index_stats():
    """Size (bytes) of the GraphRAG vector index on disk + total vectors across
    its per-project (`project_*`) collections. Used by the stats panel and the
    purge endpoint so both reflect exactly what 'Purge Regional Indexes' clears."""
    from backend.embeddings import CHROMA_PATH, chroma_client
    size = 0
    if os.path.exists(CHROMA_PATH):
        size = sum(os.path.getsize(os.path.join(dp, f))
                   for dp, _, fs in os.walk(CHROMA_PATH) for f in fs)
    nodes = 0
    try:
        for c in chroma_client.list_collections():
            if c.name.startswith("project_"):
                nodes += c.count()
    except Exception:
        nodes = 0
    return size, nodes


@app.get("/api/system/stats")
def api_system_stats():
    from backend.database import DB_PATH
    db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
    # The real GraphRAG index (chroma_db/), not the mem0 ledger.
    chroma_size, nodes = _graphrag_index_stats()

    return {
        "sqlite_db_size_mb": round(db_size / (1024 * 1024), 2),
        "chroma_db_size_mb": round(chroma_size / (1024 * 1024), 2),
        "vector_nodes": nodes
    }


@app.post("/api/system/purge-index")
def api_system_purge_index():
    """Purge the rebuildable GraphRAG index + diff cache — NOT user data.

    Deletes: every per-project (`project_*`) Chroma collection (the regional
    indexes), the incremental diff-cache rows (`file_cache`), and the in-memory
    graph. Preserves: the mem0 Memory Ledger, Notes & Tasks + compare votes
    (other tables in the same cache.db), API keys, theme, and chat history."""
    from backend.embeddings import chroma_client
    from backend.database import get_db_connection
    removed = 0
    # 1) GraphRAG regional vector collections.
    try:
        for c in chroma_client.list_collections():
            if c.name.startswith("project_"):
                try:
                    chroma_client.delete_collection(name=c.name)
                    removed += 1
                except Exception:
                    pass
    except Exception:
        pass
    # 2) Diff cache rows only (leave tasks + compare_votes intact).
    try:
        conn = get_db_connection()
        conn.execute("DELETE FROM file_cache")
        conn.commit()
        try:
            conn.execute("VACUUM")  # best-effort shrink; ignore if locked
        except Exception:
            pass
        conn.close()
    except Exception:
        pass
    # 3) Reclaim disk: Chroma's delete_collection empties the index but never
    #    shrinks chroma.sqlite3 (free pages accumulate over re-maps). Best-effort
    #    checkpoint + VACUUM in a separate connection; ignore if locked.
    try:
        import sqlite3 as _sqlite3
        from backend.embeddings import CHROMA_PATH
        _csql = os.path.join(CHROMA_PATH, "chroma.sqlite3")
        if os.path.exists(_csql):
            _c = _sqlite3.connect(_csql, timeout=10.0)
            try:
                _c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                _c.execute("VACUUM")
                _c.commit()
            finally:
                _c.close()
    except Exception:
        pass
    # 4) In-memory graph.
    APP_STATE["nodes"] = []

    chroma_size, nodes = _graphrag_index_stats()
    from backend.database import DB_PATH
    db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
    return {
        "status": "purged",
        "collections_removed": removed,
        "sqlite_db_size_mb": round(db_size / (1024 * 1024), 2),
        "chroma_db_size_mb": round(chroma_size / (1024 * 1024), 2),
        "vector_nodes": nodes
    }

# ==========================================
# Phase 6: Terminal Integration & Studio
# ==========================================
from backend.terminal_manager import terminal_manager
from backend.diff_engine import compute_diff_patches
from backend.port_manager import get_active_ports
from backend.dap_manager import dap_manager

@app.websocket("/api/dap/ws")
async def dap_websocket(ws: WebSocket):
    await dap_manager.handle_websocket(ws)

from backend.brain_pipeline import handle_brain_websocket
@app.websocket("/api/brain/ws")
async def brain_websocket(ws: WebSocket):
    await handle_brain_websocket(ws)

@app.websocket("/api/terminal/ws")
async def terminal_websocket(ws: WebSocket, cwd: Optional[str] = Query(None)):
    target_cwd = cwd if cwd else os.getcwd()
    await terminal_manager.handle_websocket(ws, cwd=target_cwd)

@app.get("/api/ports")
def get_ports():
    return {"ports": get_active_ports()}

@app.get("/api/workspace/files")
def api_workspace_files(cwd: Optional[str] = Query(None), depth: int = Query(1)):
    """Returns the workspace tree. By default `depth=1` (one level) so the
    explorer can lazy-load: a directory whose contents weren't expanded is
    returned as the placeholder `{"__lazy__": true}`, which the frontend
    renders with an arrow and fetches on first expand. This keeps huge repos
    (tens of thousands of files) from ever building a giant DOM at once."""
    target_cwd = cwd if cwd else os.getcwd()
    if not os.path.exists(target_cwd):
        return {"error": "Directory not found", "tree": {}}

    IGNORE_DIRS = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.conda'}

    def build_tree(path, level):
        tree = {}
        try:
            for item in sorted(os.listdir(path)):
                if item in IGNORE_DIRS:
                    continue
                item_path = os.path.join(path, item)
                if os.path.isdir(item_path):
                    if level <= 1:
                        # don't descend further — mark as lazily-loadable
                        tree[item] = {"__lazy__": True}
                    else:
                        tree[item] = build_tree(item_path, level - 1)
                else:
                    tree[item] = None
        except (PermissionError, OSError):
            pass
        return tree

    return {"tree": build_tree(target_cwd, max(1, depth))}

@app.get("/api/workspace/file")
def api_workspace_file_content(path: str):
    if not os.path.exists(path) or not os.path.isfile(path):
        return {"error": "File not found or is a directory"}
    
    # 50MB check
    if os.path.getsize(path) > 5 * 1024 * 1024:
        return {"error": "File too large to open in editor (>5MB)."}
    
    # Basic binary check based on extensions
    binary_exts = {'.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.ee', '.pyc', '.so', '.dll'}
    ext = os.path.splitext(path)[1].lower()
    if ext in binary_exts:
        return {"error": f"Cannot open binary/media file ({ext}) in editor."}
        
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return {"content": f.read()}
    except UnicodeDecodeError:
        return {"error": "File appears to be binary or unsupported encoding."}
    except Exception as e:
        return {"error": str(e)}

import subprocess
import platform

@app.get("/api/workspace/pick")
def api_workspace_pick(type: str = "folder"):
    try:
        if platform.system() == "Darwin":
            if type == "folder":
                cmd = ['osascript', '-e', 'POSIX path of (choose folder)']
            else:
                cmd = ['osascript', '-e', 'POSIX path of (choose file)']
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                return {"path": result.stdout.strip()}
            return {"error": "Cancelled"}
        elif platform.system() == "Windows":
            if type == "folder":
                ps_script = (
                    "Add-Type -AssemblyName System.windows.forms; "
                    "$f = New-Object System.Windows.Forms.FolderBrowserDialog; "
                    "$f.ShowNewFolderButton = $true; "
                    "if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"
                )
            else:
                ps_script = (
                    "Add-Type -AssemblyName System.windows.forms; "
                    "$f = New-Object System.Windows.Forms.OpenFileDialog; "
                    "if ($f.ShowDialog() -eq 'OK') { $f.FileName }"
                )
            result = subprocess.run(["powershell", "-Command", ps_script], capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                return {"path": result.stdout.strip()}
            return {"error": "Cancelled"}
        else:
            # Fallback for linu, using Zenity
            cmd = ['zenity', '--file-selection', '--directory'] if type == "folder" else ['zenity', '--file-selection']
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                return {"path": result.stdout.strip()}
            return {"error": "Cancelled or Zenity not installed"}
    except Exception as e:
        return {"error": str(e)}

from backend.git_manager import (
    get_status, get_diff, stage_file, commit_changes,
    init_repo, unstage_file, discard_file,
)
from backend.parser import get_all_files
import re

class WorkspaceActionRequest(BaseModel):
    repo_path: Optional[str] = None
    filepath: Optional[str] = None
    message: Optional[str] = None
    query: Optional[str] = None

@app.post("/api/git/status")
def api_git_status(req: WorkspaceActionRequest):
    target_path = req.repo_path if req.repo_path else os.getcwd()
    return get_status(target_path)

@app.post("/api/git/diff")
def api_git_diff(req: WorkspaceActionRequest):
    target_path = req.repo_path if req.repo_path else os.getcwd()
    return get_diff(target_path, req.filepath)

@app.post("/api/git/stage")
def api_git_stage(req: WorkspaceActionRequest):
    target_path = req.repo_path if req.repo_path else os.getcwd()
    return stage_file(target_path, req.filepath)

@app.post("/api/git/commit")
def api_git_commit(req: WorkspaceActionRequest):
    target_path = req.repo_path if req.repo_path else os.getcwd()
    return commit_changes(target_path, req.message)

@app.post("/api/git/init")
def api_git_init(req: WorkspaceActionRequest):
    target_path = req.repo_path if req.repo_path else os.getcwd()
    return init_repo(target_path)

@app.post("/api/git/unstage")
def api_git_unstage(req: WorkspaceActionRequest):
    target_path = req.repo_path if req.repo_path else os.getcwd()
    return unstage_file(target_path, req.filepath)

@app.post("/api/git/discard")
def api_git_discard(req: WorkspaceActionRequest):
    target_path = req.repo_path if req.repo_path else os.getcwd()
    return discard_file(target_path, req.filepath)

class CreateResourceRequest(BaseModel):
    path: str

@app.post("/api/workspace/file")
def api_workspace_create_file(req: CreateResourceRequest):
    try:
        os.makedirs(os.path.dirname(req.path), exist_ok=True)
        if not os.path.exists(req.path):
            with open(req.path, 'w', encoding='utf-8') as f:
                f.write('')
        return {"success": True, "path": req.path}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/workspace/folder")
def api_workspace_create_folder(req: CreateResourceRequest):
    try:
        os.makedirs(req.path, exist_ok=True)
        return {"success": True, "path": req.path}
    except Exception as e:
        return {"error": str(e)}

# ---- file-tree operations (rename / delete / move / copy) ------------------
class RenameRequest(BaseModel):
    path: str
    new_path: str

class PathRequest(BaseModel):
    path: str

class MoveCopyRequest(BaseModel):
    src: str
    dest_dir: str

def _guard_path(p: str):
    """Block obviously-dangerous targets (filesystem root, home, empty)."""
    if not p or not str(p).strip():
        return "Empty path."
    ap = os.path.abspath(os.path.expanduser(str(p)))
    if ap in (os.path.abspath(os.sep), os.path.abspath(os.path.expanduser("~"))):
        return "Refusing to operate on this top-level path."
    return None

@app.get("/api/workspace/raw")
def api_workspace_raw(path: str = Query(...)):
    """Serve a file as-is (used by the tree's 'Open in Images Preview')."""
    if _guard_path(path) or not os.path.isfile(path):
        return {"error": "Not a file."}
    return FileResponse(path)

@app.post("/api/workspace/rename")
def api_workspace_rename(req: RenameRequest):
    err = _guard_path(req.path) or _guard_path(req.new_path)
    if err:
        return {"error": err}
    try:
        if os.path.exists(req.new_path):
            return {"error": "Target already exists."}
        os.makedirs(os.path.dirname(os.path.abspath(req.new_path)), exist_ok=True)
        os.rename(req.path, req.new_path)
        return {"success": True, "path": req.new_path}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/workspace/delete")
def api_workspace_delete(req: PathRequest):
    err = _guard_path(req.path)
    if err:
        return {"error": err}
    try:
        if os.path.isdir(req.path):
            shutil.rmtree(req.path)
        elif os.path.exists(req.path):
            os.remove(req.path)
        else:
            return {"error": "Path not found."}
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/workspace/move")
def api_workspace_move(req: MoveCopyRequest):
    err = _guard_path(req.src) or _guard_path(req.dest_dir)
    if err:
        return {"error": err}
    try:
        dest = os.path.join(req.dest_dir, os.path.basename(req.src.rstrip("/")))
        if os.path.abspath(dest) == os.path.abspath(req.src):
            return {"error": "Source and destination are the same."}
        shutil.move(req.src, dest)
        return {"success": True, "path": dest}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/workspace/copy")
def api_workspace_copy(req: MoveCopyRequest):
    err = _guard_path(req.src) or _guard_path(req.dest_dir)
    if err:
        return {"error": err}
    try:
        base = os.path.basename(req.src.rstrip("/"))
        dest = os.path.join(req.dest_dir, base)
        # avoid clobbering: append " copy" if needed
        if os.path.exists(dest):
            stem, ext = os.path.splitext(base)
            dest = os.path.join(req.dest_dir, f"{stem} copy{ext}")
        if os.path.isdir(req.src):
            shutil.copytree(req.src, dest)
        else:
            shutil.copy2(req.src, dest)
        return {"success": True, "path": dest}
    except Exception as e:
        return {"error": str(e)}

class SaveFileRequest(BaseModel):
    path: str
    content: str

@app.post("/api/workspace/save")
def api_workspace_save_file(req: SaveFileRequest):
    """Persist editor buffer contents back to disk (powers Save / Save All)."""
    try:
        parent = os.path.dirname(req.path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(req.path, 'w', encoding='utf-8') as f:
            f.write(req.content)
        return {"success": True, "path": req.path}
    except Exception as e:
        return {"error": str(e)}

def _require_workspace_root(repo_path):
    """Guard for destructive/whole-tree ops: the caller MUST pass an explicit,
    existing directory. Never silently fall back to the server's CWD — that is
    exactly the footgun that let a stray request rewrite the whole machine."""
    if not repo_path or not str(repo_path).strip():
        return None, {"error": "repo_path is required (an explicit workspace folder)."}
    root = os.path.abspath(os.path.expanduser(str(repo_path)))
    if not os.path.isdir(root):
        return None, {"error": f"repo_path is not a directory: {root}"}
    # refuse obviously-too-broad roots (home, filesystem root, /)
    forbidden = {os.path.abspath(os.sep), os.path.abspath(os.path.expanduser("~"))}
    if root in forbidden:
        return None, {"error": "repo_path is too broad; point at a project folder."}
    return root, None


@app.post("/api/workspace/search")
def api_workspace_search(req: WorkspaceActionRequest):
    if not req.query:
        return {"results": []}
    target_path, err = _require_workspace_root(req.repo_path)
    if err:
        return err
    files = get_all_files(target_path)
    results = []
    pattern = re.compile(re.escape(req.query), re.IGNORECASE)
    for fpath in files:
        try:
            with open(fpath, 'r', encoding='utf-8') as f:
                content = f.read()
                if pattern.search(content):
                    lines = content.splitlines()
                    for i, line in enumerate(lines):
                        if pattern.search(line):
                            results.append({
                                "file": os.path.relpath(fpath, target_path),
                                "line_number": i + 1,
                                "match": line.strip()[:300]
                            })
                            if len(results) >= 100:
                                return {"results": results}
        except Exception:
            continue
    return {"results": results}

class WorkspaceReplaceRequest(BaseModel):
    repo_path: Optional[str] = None
    query: str
    replacement: str = ""
    confirm: bool = False

@app.post("/api/workspace/replace")
def api_workspace_replace(req: WorkspaceReplaceRequest):
    """Literal (case-sensitive) find & replace across the workspace.
    Returns the absolute paths of changed files so the IDE can reload open tabs.

    Safety guards (a mistake here once rewrote 4,800+ files):
    - repo_path is REQUIRED and must be an explicit existing project folder.
    - query must be at least 2 chars unless confirm=True (block 1-char sweeps).
    - never falls back to the server CWD.
    """
    if not req.query:
        return {"error": "Empty search term."}
    target_path, err = _require_workspace_root(req.repo_path)
    if err:
        return err
    if len(req.query) < 2 and not req.confirm:
        return {"error": "Refusing a 1-character workspace-wide replace without confirm=true "
                         "(this is destructive — narrow the query or set confirm)."}
    changed = []
    try:
        for fpath in get_all_files(target_path):
            try:
                with open(fpath, 'r', encoding='utf-8') as f:
                    content = f.read()
                if req.query not in content:
                    continue
                with open(fpath, 'w', encoding='utf-8') as f:
                    f.write(content.replace(req.query, req.replacement))
                changed.append(fpath)
            except (UnicodeDecodeError, PermissionError, OSError):
                continue
        return {"count": len(changed), "changed": changed}
    except Exception as e:
        return {"error": str(e)}

class DiffRequest(BaseModel):
    original_text: str
    modified_text: str

@app.post("/api/suggest-diff")
async def suggest_diff(request: DiffRequest):
    patches = compute_diff_patches(request.original_text, request.modified_text)
    return {"patches": patches}

# ==========================================
# Phase 7 — Omni-Document Studio & Deep Research Hub
# ==========================================
import json as _json

def _sse(payload: dict) -> str:
    """Format one Server-Sent Event frame."""
    return f"data: {_json.dumps(payload)}\n\n"

@app.get("/api/doc/read")
def api_doc_read(path: str = Query(...)):
    """Extract a binary document (.docx/.doc/.rtf) to plain text/markdown for the
    rich-text editor. Reuses parser.extract_text_from_docx."""
    try:
        ext = path.rsplit(".", 1)[-1].lower()
        if ext in ("docx", "doc"):
            from backend.parser import extract_text_from_docx
            text = extract_text_from_docx(path)
        else:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        return {"markdown": text}
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/research")
async def api_research(query: str = Query(...), project_id: str = Query("default"),
                       model: str = Query("local"), max_links: int = Query(5),
                       topic: str = Query("")):
    """Deep Research Hub (SSE): search -> crawl -> sklearn analysis -> LLM synthesis,
    streamed as Markdown. Blocking work runs in a thread so the server never stalls.
    `max_links` (depth) and `model` are honored; `topic` titles the report."""
    from backend.workers.research_agent import gather, build_synthesis_prompt
    import functools

    title = (topic or query).strip()

    async def gen():
        try:
            yield _sse({"text": f"# {title}\n\n_Researching the web…_\n\n"})
            loop = asyncio.get_event_loop()
            # Honor the depth slider (5 / 8 = thorough).
            brief = await loop.run_in_executor(None, functools.partial(gather, query, max_links=max_links))
            pages = brief.get("pages_read", 0)
            if pages == 0:
                yield _sse({"text": "_No readable sources were found — writing from general knowledge._\n\n"})
            else:
                yield _sse({"text": f"_Analyzed {pages} sources. Synthesizing…_\n\n---\n\n"})
            # Sources-first, model fills gaps: ground in crawled pages but expand
            # into a thorough, well-structured report rather than a stub.
            system = ("You are an expert research analyst. Write a thorough, well-structured "
                      "Markdown report on the topic with clear ## headings, an intro, multiple "
                      "detailed sections, bullet points where useful, and a final 'Sources' list. "
                      "Ground claims in the provided source material and cite sources where used; "
                      "where sources are thin, expand accurately from your own expertise. Aim for "
                      "depth and completeness — not a single paragraph.")
            prompt = build_synthesis_prompt(brief)
            async for chunk in run_contextual_chat(prompt, "", provider=model, system_prompt=system):
                if chunk:
                    yield _sse({"text": chunk})
            yield _sse({"event": "done"})
        except Exception as e:
            yield _sse({"error": str(e)})
            yield _sse({"event": "done"})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

@app.get("/api/doc/ai-suggest")
async def api_doc_ai_suggest(instruction: str = Query(...), text: str = Query(""), model: str = Query("local")):
    """Inline AI rewrite/expand of a document selection (SSE Markdown stream)."""
    async def gen():
        try:
            system = ("You are an expert writing assistant. Apply the user's instruction to the "
                      "selected text and return ONLY the revised text in Markdown — no preamble.")
            prompt = f"Instruction: {instruction}\n\nSelected text:\n{text}"
            async for chunk in run_contextual_chat(prompt, "", provider=model, system_prompt=system):
                if chunk:
                    yield _sse({"text": chunk})
            yield _sse({"event": "done"})
        except Exception as e:
            yield _sse({"error": str(e)}); yield _sse({"event": "done"})
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

class DocGrammarRequest(BaseModel):
    text: str
    context: str = ""

@app.post("/api/doc/grammar")
async def api_doc_grammar(req: DocGrammarRequest):
    """Grammarly-style check: returns a JSON list of {original, suggestion, reason}
    where `original` is a verbatim substring of the input. Local-LLM backed; on any
    failure returns an empty list so the editor silently degrades."""
    if not req.text or len(req.text.strip()) < 8:
        return {"suggestions": []}
    system = ("You are a precise grammar and style checker. Return ONLY a JSON array (max 20) of objects "
              '{"original": <EXACT verbatim substring of the text>, "suggestion": <corrected text>, '
              '"reason": <very short reason>}. Flag only real spelling/grammar/clarity errors. '
              "The 'original' MUST appear verbatim in the input. If there are no errors, return [].")
    prompt = (f"Writing type: {req.context}\n\n" if req.context else "") + "Text:\n" + req.text
    out = ""
    try:
        async for chunk in run_contextual_chat(prompt, "", provider="local", system_prompt=system):
            out += chunk
            if len(out) > 6000:
                break
    except Exception as e:
        return {"suggestions": [], "error": str(e)}
    m = re.search(r'\[.*\]', out, re.DOTALL)
    try:
        arr = _json.loads(m.group(0)) if m else []
    except Exception:
        arr = []
    sugg = [s for s in arr
            if isinstance(s, dict) and s.get("original") and s.get("suggestion")
            and s["original"] != s["suggestion"] and s["original"] in req.text]
    return {"suggestions": sugg[:25]}

class DocCompleteRequest(BaseModel):
    text: str
    context: str = ""

@app.post("/api/doc/complete")
async def api_doc_complete(req: DocCompleteRequest):
    """Ghost-text autocomplete: a short, natural continuation of the user's text."""
    if not req.text or len(req.text.strip()) < 8:
        return {"completion": ""}
    system = ("You are an inline writing autocomplete. Continue the user's text with a short, natural "
              "completion — a few words up to a single sentence. Return ONLY the continuation text: no "
              "quotes, no preamble, and do NOT repeat the user's words.")
    prompt = (f"Writing type: {req.context}\n" if req.context else "") + req.text
    out = ""
    try:
        async for chunk in run_contextual_chat(prompt, "", provider="local", system_prompt=system):
            out += chunk
            if len(out) > 180:
                break
    except Exception as e:
        return {"completion": "", "error": str(e)}
    return {"completion": out.strip().strip('"').strip()[:200]}

class DocExportRequest(BaseModel):
    format: str = "docx"          # 'docx' | 'pdf'
    title: str = "document"
    html: str = ""
    markdown: str = ""

@app.post("/api/export-doc")
def api_export_doc(req: DocExportRequest):
    """Server-side document export: DOCX via python-docx, PDF via ReportLab.
    Bundled in the PyInstaller spec so it runs offline inside the packaged app."""
    from backend.docx_generator import markdown_to_docx_bytes, markdown_to_pdf_bytes
    try:
        src = req.markdown or req.html
        if req.format == "pdf":
            data = markdown_to_pdf_bytes(src, req.title)
            media = "application/pdf"
        else:
            data = markdown_to_docx_bytes(src, req.title)
            media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        return StreamingResponse(io.BytesIO(data), media_type=media, headers={
            "Content-Disposition": f'attachment; filename="{req.title}.{req.format}"'
        })
    except Exception as e:
        return {"error": str(e)}

# ==========================================
# Phase 8 — Utilities Studio: Notes & Tasks
# ==========================================
import time as _time


class TaskCreateRequest(BaseModel):
    kind: str = "task"          # 'note' | 'task' | 'reminder'
    title: str = ""
    body: str = ""
    done: bool = False
    due_at: Optional[float] = None   # unix ts for one-shot reminders
    cron: Optional[str] = None       # "m h dom mon dow" for repeating reminders


class TaskUpdateRequest(BaseModel):
    kind: Optional[str] = None
    title: Optional[str] = None
    body: Optional[str] = None
    done: Optional[bool] = None
    due_at: Optional[float] = None
    cron: Optional[str] = None
    fired: Optional[bool] = None


@app.get("/api/tasks")
def api_list_tasks(kind: str = ""):
    """List notes/tasks/reminders (direct read; WAL allows concurrent readers)."""
    conn = get_db_connection()
    try:
        cur = conn.cursor()
        if kind:
            cur.execute(
                """SELECT id, kind, title, body, done, due_at, cron, fired, created_at, updated_at
                   FROM tasks WHERE kind = ? ORDER BY created_at DESC""", (kind,))
        else:
            cur.execute(
                """SELECT id, kind, title, body, done, due_at, cron, fired, created_at, updated_at
                   FROM tasks ORDER BY created_at DESC""")
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        return {"status": "success", "tasks": rows}
    except Exception as e:
        return {"status": "error", "message": str(e), "tasks": []}
    finally:
        conn.close()


@app.post("/api/tasks")
def api_create_task(req: TaskCreateRequest):
    """Create a task. Writes go through the single-writer queue. For cron
    reminders we precompute the first due_at so the daemon fires on schedule."""
    payload = req.model_dump()
    if payload.get("kind") == "reminder" and payload.get("cron") and not payload.get("due_at"):
        payload["due_at"] = cron_next(payload["cron"], _time.time())
    try:
        result = task_submit("create", payload)
        return {"status": "success", **result}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.patch("/api/tasks/{task_id}")
def api_update_task(task_id: int, req: TaskUpdateRequest):
    """Update a task (toggle done, edit fields, reschedule). Re-arming a fired
    reminder with a new cron recomputes its next due_at."""
    payload = {k: v for k, v in req.model_dump().items() if v is not None}
    payload["id"] = task_id
    if payload.get("cron") and "due_at" not in payload:
        payload["due_at"] = cron_next(payload["cron"], _time.time())
        payload["fired"] = False
    try:
        result = task_submit("update", payload)
        return {"status": "success", **result}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.delete("/api/tasks/{task_id}")
def api_delete_task(task_id: int):
    """Delete a task."""
    try:
        result = task_submit("delete", {"id": task_id})
        return {"status": "success", **result}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ==========================================
# Phase 8 — Utilities Studio: Email & Calendar (DRAFT-ONLY)
# ==========================================
import json as _json
import re as _re
from backend.workers import comms_bridge


class CommsParseRequest(BaseModel):
    text: str
    kind: str = "mail"           # 'mail' | 'event'
    provider: str = ""           # optional ollama model override ("local:<model>")


class CommsDraftRequest(BaseModel):
    provider: str                # 'apple_mail' | 'outlook' | 'gmail'
    kind: str = "mail"           # 'mail' | 'event'
    to: str = ""
    subject: str = ""
    body: str = ""
    start: str = ""
    end: str = ""
    location: str = ""


def _resolve_local_provider(provider: str) -> str:
    """Return a usable 'local:<model>' string: honor an explicit choice, else
    pick the first installed Ollama model, else fall back to the default."""
    if provider and provider.startswith("local"):
        return provider
    try:
        resp = requests.get("http://localhost:11434/api/tags", timeout=3)
        models = [m["name"] for m in resp.json().get("models", [])]
        if models:
            return "local:" + models[0]
    except Exception:
        pass
    return "local"


def _strip_code_fences(text: str) -> str:
    """Remove a wrapping ```json ... ``` / ``` ... ``` markdown fence."""
    t = text.strip()
    fence = _re.match(r"^```[a-zA-Z]*\s*\n?(.*?)\n?```\s*$", t, _re.DOTALL)
    if fence:
        return fence.group(1).strip()
    return t


def _extract_json(text: str, kind: str = "mail") -> dict:
    """Robustly pull structured draft fields out of an LLM response.

    Local models frequently wrap the JSON in a code fence and put RAW newlines
    inside the `body` string — which is invalid JSON, so `json.loads` fails. We
    (1) strip fences, (2) try a strict parse, then (3) fall back to per-field
    regexes so To/Subject/Body always land in their own fields and braces/fences
    never leak into the body.
    """
    if not text:
        return {}
    cleaned = _strip_code_fences(text)
    m = _re.search(r"\{.*\}", cleaned, _re.DOTALL)
    blob = m.group(0) if m else cleaned

    # 1) Strict parse (works when the model escaped newlines properly).
    if m:
        try:
            return _json.loads(blob)
        except Exception:
            pass

    # 2) Lenient per-field extraction. `body`/`title` may span multiple raw lines.
    def field(name, multiline=False):
        if multiline:
            # capture up to the closing quote that precedes the next "key": or the final }
            pat = r'"%s"\s*:\s*"(.*?)"\s*(?:,\s*"[a-zA-Z_]+"\s*:|\}\s*)' % name
            mm = _re.search(pat, blob, _re.DOTALL)
        else:
            mm = _re.search(r'"%s"\s*:\s*"([^"]*)"' % name, blob)
        if not mm:
            return ""
        val = mm.group(1)
        # un-escape common sequences; collapse literal backslash-n to newline
        val = val.replace("\\n", "\n").replace('\\"', '"').replace("\\t", "\t")
        return val.strip()

    if kind == "event":
        fields = {
            "title": field("title"),
            "body": field("body", multiline=True),
            "start": field("start"),
            "end": field("end"),
            "location": field("location"),
        }
    else:
        fields = {
            "to": field("to"),
            "subject": field("subject"),
            "body": field("body", multiline=True),
        }
    # Only return if we actually recovered something meaningful.
    if any(v for v in fields.values()):
        return fields
    return {}


@app.get("/api/comms/providers")
def api_comms_providers():
    """OS-aware provider list (gmail always included)."""
    return {"status": "success", "providers": comms_bridge.list_providers()}


@app.post("/api/comms/parse")
async def api_comms_parse(req: CommsParseRequest):
    """Turn a casual instruction into structured draft fields via the local LLM.
    Returns JSON only — this never touches Mail/Calendar."""
    if req.kind == "event":
        sys_prompt = (
            "You convert a casual instruction into a calendar event. "
            "Return ONLY a raw JSON object — no markdown, no code fences, no prose. "
            "Keys: title, body, start, end, location. "
            'Use ISO 8601 "YYYY-MM-DDTHH:MM" for start/end when a time is implied, '
            "else empty strings. Escape any newlines inside string values as \\n. "
            "Do not put the subject/title text inside the body."
        )
    else:
        sys_prompt = (
            "You convert a casual instruction into an email draft. "
            "Return ONLY a raw JSON object — no markdown, no code fences, no prose. "
            "Keys: to, subject, body. The 'subject' is a short one-line subject; the "
            "'body' is the email message ONLY (do not repeat the subject in the body, "
            "and do not include the JSON braces). Leave 'to' empty if no recipient is "
            "named. Escape any newlines inside string values as \\n."
        )
    provider = _resolve_local_provider(req.provider)
    buf = ""
    try:
        async for chunk in run_contextual_chat(req.text, "", provider=provider, system_prompt=sys_prompt):
            buf += chunk
    except Exception as e:
        return {"status": "error", "message": str(e), "fields": {}}
    fields = _extract_json(buf, kind=req.kind)
    if not fields:
        # Degrade gracefully: drop the raw text into the body so the user can edit.
        fields = {"to": "", "subject": "", "body": buf.strip() or req.text} if req.kind == "mail" \
            else {"title": "", "body": req.text, "start": "", "end": "", "location": ""}
    return {"status": "success", "kind": req.kind, "fields": fields}


@app.post("/api/comms/draft")
def api_comms_draft(req: CommsDraftRequest):
    """Open a DRAFT in the chosen provider. Never sends/saves autonomously."""
    fields = {"to": req.to, "subject": req.subject, "body": req.body,
              "title": req.subject, "start": req.start, "end": req.end, "location": req.location}
    try:
        return comms_bridge.make_draft(req.provider, req.kind, fields)
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ==========================================
# Phase 8 — Utilities Studio: Model Cookbook (Ollama-only)
# ==========================================
from backend.workers import cookbook


@app.get("/api/cookbook/scan")
def api_cookbook_scan():
    """RAM / CPU / GPU / VRAM summary for the Fit Score."""
    return {"status": "success", "hardware": cookbook.scan_hardware()}


@app.get("/api/cookbook/recommend")
def api_cookbook_recommend():
    """Curated Ollama catalog scored against this machine, best-fit first."""
    return {"status": "success", **cookbook.recommend()}


@app.get("/api/cookbook/installed")
def api_cookbook_installed():
    """List installed Ollama models with sizes — powers the in-app delete UI."""
    try:
        r = requests.get("http://localhost:11434/api/tags", timeout=3)
        if r.status_code != 200:
            return {"models": [], "error": f"Ollama returned {r.status_code}."}
        models = r.json().get("models", [])
        out = [{"name": m.get("name", ""),
                "size_gb": round(m.get("size", 0) / 1e9, 2)} for m in models]
        return {"models": out}
    except requests.exceptions.ConnectionError:
        return {"models": [], "error": "Ollama daemon not running"}
    except Exception as e:
        return {"models": [], "error": str(e)}


class DeleteModelRequest(BaseModel):
    model: str


@app.post("/api/cookbook/delete")
def api_cookbook_delete(req: DeleteModelRequest):
    """Delete an installed Ollama model (in-app, no terminal `ollama rm`)."""
    name = (req.model or "").strip()
    if not name:
        return {"error": "No model specified."}
    try:
        r = requests.delete("http://localhost:11434/api/delete",
                            json={"name": name}, timeout=30)
        if r.status_code == 200:
            return {"status": "deleted", "model": name}
        detail = ""
        try:
            detail = r.text
        except Exception:
            pass
        return {"error": f"Ollama returned {r.status_code}. {detail[:200]}".strip()}
    except requests.exceptions.ConnectionError:
        return {"error": "Ollama daemon not running"}
    except Exception as e:
        return {"error": str(e)}


@app.get("/api/cookbook/pull")
def api_cookbook_pull(model: str = Query(...)):
    """Stream `ollama pull <model>` progress as Server-Sent Events (GET so the
    frontend can consume it with EventSource)."""
    def _clean_pull_error(msg: str) -> str:
        """Turn raw Ollama pull errors into actionable guidance."""
        low = (msg or "").lower()
        if "412" in low or "newer version of ollama" in low:
            return ("This model needs a newer version of Ollama than you have "
                    "installed. Update Ollama at https://ollama.com/download, "
                    "then try again.")
        return msg

    def event_stream():
        try:
            with requests.post("http://localhost:11434/api/pull",
                               json={"model": model, "stream": True},
                               stream=True, timeout=None) as r:
                if r.status_code != 200:
                    detail = ""
                    try:
                        detail = r.text
                    except Exception:
                        pass
                    if r.status_code == 412 or "newer version" in detail.lower():
                        msg = _clean_pull_error("412 newer version of ollama")
                    else:
                        msg = f'Ollama returned {r.status_code}. {detail[:200]}'.strip()
                    yield f"data: {_json.dumps({'error': msg})}\n\n"
                    return
                for line in r.iter_lines():
                    if not line:
                        continue
                    try:
                        obj = _json.loads(line.decode("utf-8"))
                    except Exception:
                        continue
                    out = {"status": obj.get("status", "")}
                    if "completed" in obj and "total" in obj and obj.get("total"):
                        out["completed"] = obj["completed"]
                        out["total"] = obj["total"]
                        out["pct"] = round(obj["completed"] / obj["total"] * 100, 1)
                    if obj.get("error"):
                        out["error"] = _clean_pull_error(obj["error"])
                    yield f"data: {_json.dumps(out)}\n\n"
                yield f"data: {_json.dumps({'done': True})}\n\n"
        except requests.exceptions.ConnectionError:
            yield f"data: {_json.dumps({'error': 'Ollama daemon not running'})}\n\n"
        except Exception as e:
            yield f"data: {_json.dumps({'error': str(e)})}\n\n"
    return StreamingResponse(event_stream(), media_type="text/event-stream")


def restart_ollama_server():
    """Best-effort, OS-aware restart of the running Ollama server so a freshly
    upgraded binary becomes the live version. Detached + non-fatal. Returns a
    short status string."""
    import shutil as _shutil
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(["osascript", "-e", 'tell application "Ollama" to quit'],
                           timeout=15, capture_output=True)
            subprocess.run(["killall", "ollama"], timeout=10, capture_output=True)
            _time.sleep(2)
            if os.path.exists("/Applications/Ollama.app"):
                subprocess.Popen(["open", "-a", "Ollama"],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return "Relaunched the Ollama app."
            if _shutil.which("ollama"):
                subprocess.Popen("nohup ollama serve >/dev/null 2>&1 &", shell=True,
                                 start_new_session=True)
                return "Restarted `ollama serve`."
            return "Couldn't find Ollama to relaunch — open it manually."
        if system == "Linux":
            for svc in (["systemctl", "--user", "restart", "ollama"],
                        ["systemctl", "restart", "ollama"]):
                try:
                    r = subprocess.run(svc, timeout=15, capture_output=True)
                    if r.returncode == 0:
                        return "Restarted the Ollama service."
                except Exception:
                    pass
            subprocess.run(["pkill", "-f", "ollama serve"], timeout=10, capture_output=True)
            _time.sleep(2)
            if _shutil.which("ollama"):
                subprocess.Popen("nohup ollama serve >/dev/null 2>&1 &", shell=True,
                                 start_new_session=True)
                return "Restarted `ollama serve`."
            return "Couldn't restart Ollama — start it manually."
        if system == "Windows":
            subprocess.run(["taskkill", "/IM", "ollama.exe", "/F"], timeout=10, capture_output=True)
            _time.sleep(2)
            if _shutil.which("ollama"):
                subprocess.Popen(["ollama", "serve"], creationflags=getattr(subprocess, "DETACHED_PROCESS", 0),
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return "Restarted Ollama."
            return "Couldn't restart Ollama — reopen it manually."
    except Exception as e:
        return f"Auto-restart failed ({e}) — quit and reopen Ollama to finish."
    return "Restart not supported on this OS — reopen Ollama manually."


@app.get("/api/cookbook/update-ollama")
def api_cookbook_update_ollama():
    """Update Ollama to the latest version via the OS-appropriate package
    manager / official installer, streamed as SSE (like model pulls), then
    auto-restart the server so the new version takes effect. User-initiated
    only. Degrades to a clear 'download manually' message when no auto-update
    path is available — never crashes."""
    import shutil as _shutil

    def pick_command():
        system = platform.system()
        if system == "Darwin":
            if _shutil.which("brew"):
                return ["brew", "upgrade", "ollama"], "Homebrew"
            return None, "macOS without Homebrew"
        if system == "Linux":
            if _shutil.which("curl") and _shutil.which("sh"):
                # Official Ollama install script (also upgrades in place).
                return ["sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"], "official installer"
            return None, "Linux without curl"
        if system == "Windows":
            if _shutil.which("winget"):
                return ["winget", "upgrade", "--id", "Ollama.Ollama", "--silent",
                        "--accept-source-agreements", "--accept-package-agreements"], "winget"
            return None, "Windows without winget"
        return None, system or "unknown OS"

    def event_stream():
        cmd, label = pick_command()
        if not cmd:
            yield f"data: {_json.dumps({'error': f'Auto-update not available on {label}. Download the latest Ollama at https://ollama.com/download, then reopen the Cookbook.'})}\n\n"
            return
        yield f"data: {_json.dumps({'status': f'Updating Ollama via {label}…'})}\n\n"
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in iter(proc.stdout.readline, ''):
                line = line.rstrip()
                if line:
                    yield f"data: {_json.dumps({'status': line[:300]})}\n\n"
            proc.wait()
            if proc.returncode != 0:
                yield f"data: {_json.dumps({'error': f'Update exited with code {proc.returncode}. You can also download it at https://ollama.com/download.'})}\n\n"
                return
            # The CLI binary is upgraded, but the RUNNING server is still the old
            # version until it restarts — auto-restart it so models stop 412-ing.
            yield f"data: {_json.dumps({'status': 'Restarting the Ollama server…'})}\n\n"
            msg = restart_ollama_server()
            yield f"data: {_json.dumps({'status': msg})}\n\n"
            # Poll the live server version so we can confirm the new one is up.
            new_ver = ""
            for _ in range(10):
                _time.sleep(1)
                try:
                    new_ver = requests.get("http://localhost:11434/api/version", timeout=2).json().get("version", "")
                except Exception:
                    new_ver = ""
                if new_ver:
                    break
            final = f"Ollama updated and restarted — now running {new_ver}." if new_ver \
                else "Ollama updated. If models still fail, quit and reopen Ollama."
            yield f"data: {_json.dumps({'status': final, 'done': True})}\n\n"
        except Exception as e:
            yield f"data: {_json.dumps({'error': f'Update failed: {e}. Download at https://ollama.com/download.'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


class WarmupRequest(BaseModel):
    model: str = ""


@app.post("/api/warmup")
def api_warmup(req: WarmupRequest):
    """Preload an Ollama model into memory (keep_alive) so the user's FIRST real
    prompt doesn't pay the cold-load stall. Fired when they switch models.
    Only Ollama `local:` models — MLX/cloud load on their own path. Non-fatal."""
    m = (req.model or "").strip()
    if not m.startswith("local:"):
        return {"status": "skipped"}
    name = m[6:]

    def _load():
        try:
            # Empty prompt + keep_alive loads the model and holds it resident.
            requests.post("http://127.0.0.1:11434/api/generate",
                          json={"model": name, "keep_alive": "30m"}, timeout=120)
        except Exception:
            pass

    threading.Thread(target=_load, daemon=True).start()
    return {"status": "warming", "model": name}


@app.get("/api/cookbook/install-ollama")
def api_cookbook_install_ollama():
    """Install Ollama via the OS package manager / official installer, streamed
    as SSE, then start the server. Zero-terminal. Degrades to a clear download
    message when no installer is available."""
    import shutil as _shutil

    def pick_command():
        system = platform.system()
        if system == "Darwin":
            if _shutil.which("brew"):
                return ["brew", "install", "ollama"], "Homebrew"
            return None, "macOS without Homebrew"
        if system == "Linux":
            if _shutil.which("curl") and _shutil.which("sh"):
                return ["sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"], "official installer"
            return None, "Linux without curl"
        if system == "Windows":
            if _shutil.which("winget"):
                return ["winget", "install", "--id", "Ollama.Ollama", "--silent",
                        "--accept-source-agreements", "--accept-package-agreements"], "winget"
            return None, "Windows without winget"
        return None, system or "unknown OS"

    def event_stream():
        cmd, label = pick_command()
        if not cmd:
            yield f"data: {_json.dumps({'error': f'Auto-install not available on {label}. Download Ollama at https://ollama.com/download, then reopen the Cookbook.'})}\n\n"
            return
        yield f"data: {_json.dumps({'status': f'Installing Ollama via {label}…'})}\n\n"
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in iter(proc.stdout.readline, ''):
                line = line.rstrip()
                if line:
                    yield f"data: {_json.dumps({'status': line[:300]})}\n\n"
            proc.wait()
            if proc.returncode != 0:
                yield f"data: {_json.dumps({'error': f'Install exited with code {proc.returncode}. You can also download it at https://ollama.com/download.'})}\n\n"
                return
            yield f"data: {_json.dumps({'status': 'Starting the Ollama server…'})}\n\n"
            yield f"data: {_json.dumps({'status': restart_ollama_server()})}\n\n"
            new_ver = ""
            for _ in range(10):
                _time.sleep(1)
                try:
                    new_ver = requests.get("http://localhost:11434/api/version", timeout=2).json().get("version", "")
                except Exception:
                    new_ver = ""
                if new_ver:
                    break
            final = f"Ollama installed and running ({new_ver})." if new_ver \
                else "Ollama installed. If it isn't detected, open the Ollama app once."
            yield f"data: {_json.dumps({'status': final, 'done': True})}\n\n"
        except Exception as e:
            yield f"data: {_json.dumps({'error': f'Install failed: {e}. Download at https://ollama.com/download.'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ==========================================
# Phase 8 — Utilities Studio: Model Compare (blind testing)
# ==========================================
class CompareVoteRequest(BaseModel):
    prompt: str
    model_a: str
    model_b: str
    winner: str          # 'A' | 'B' | 'tie'


@app.get("/api/compare")
async def api_compare(prompt: str = Query(...),
                      model_a: str = Query(...),
                      model_b: str = Query(...)):
    """Blind comparison via SSE. Context-Switching Serialization: model A runs
    to completion, THEN model B — so a single-GPU / tight-VRAM box never has to
    hold both resident at once. Each chunk is tagged with its column ('A'/'B');
    the frontend owns the (anonymized, randomized) model↔column mapping."""
    async def event_stream():
        for col, model in (("A", model_a), ("B", model_b)):
            yield f"data: {_json.dumps({'col': col, 'event': 'start'})}\n\n"
            try:
                async for chunk in run_contextual_chat(prompt, "", provider="local:" + model):
                    yield f"data: {_json.dumps({'col': col, 'text': chunk})}\n\n"
            except Exception as e:
                yield f"data: {_json.dumps({'col': col, 'text': f'[error: {e}]'})}\n\n"
            yield f"data: {_json.dumps({'col': col, 'event': 'col_done'})}\n\n"
        yield f"data: {_json.dumps({'done': True})}\n\n"
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/compare/vote")
def api_compare_vote(req: CompareVoteRequest):
    """Persist a blind-test vote (winner is revealed client-side after voting)."""
    try:
        result = task_submit("record_vote", req.model_dump())
        return {"status": "success", **result}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ==========================================
# Seamless Frontend Servicing
# ==========================================
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

@app.get("/")
async def serve_index():
    """Serves the main workspace directly on the root URL."""
    return FileResponse(
        os.path.join(FRONTEND_DIR, "index.html"),
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Epires": "0"
        }
    )
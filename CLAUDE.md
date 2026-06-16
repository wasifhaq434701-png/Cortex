# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Mind Palace (aka **Cortex IDE**) is a local-first AI Data Intelligence OS: it ingests a user's files/code/databases, maps them into a 3D semantic graph (GraphRAG), and exposes two front-ends over the same FastAPI backend — an **Immersive** mode (3D graph + chat) and a **Studio** mode (a VS Code-style in-browser IDE).

**North-star goal that constrains design decisions:** ship as a one-click `.dmg`/`.exe` installer with **zero required terminal interaction** for the end user. The installer bundles the app + Python backend, but cannot bundle every language toolchain — so the Studio code runner invokes whatever compilers/interpreters are already installed on the machine (same model as VS Code's Code Runner), and missing toolchains must surface as clean in-app messages, never crashes.

## Running the app

The backend package root is the `mind-palace/` directory (all imports are `from backend.`). Run from there:

cd mind-palace

uvicorn backend.main:app --reload --port 8000 # serves the full UI at http://localhost:8000/

1.  Requires all of `requirements.txt` installed in the active interpreter (FastAPI, sentence-transformers, chromadb, mem0ai, litellm, pandas, etc.). **Ollama** must be running at `127.0.0.1:11434` for local models; `pytesseract`/Tesseract is optional (enables image OCR).
2.  **Import is heavy and slow:** `backend/embeddings.py` loads a `SentenceTransformer` model and opens ChromaDB at module import. A full boot can take tens of seconds and pulls the entire ML stack. **Prefer verifying backend changes with** `**python -m py_compile backend/main.py**` **and a minimal FastAPI harness over a full server boot.**
3.  There is **no formal test suite**. The `test_*.py` files at the repo root are ad-hoc smoke scripts (websocket/mem0 probes), not pytest. Verify frontend JS with `node --check <file>.js`.

## Architecture

### Ingestion pipeline (`POST /api/process`)

`main.py` orchestrates: `database.scan_incremental` (SHA-256 diff cache in `cache.db`, only reprocesses changed files) → `parser.process_files` (universal extraction: code, PDF/DOCX/PPTX/XLSX, CSV, SQLite `.db`/`.sql`, image OCR; chunks text and builds Pandas profiles for tabular data) → `embeddings.generate_embeddings` (MiniLM vectors upserted into a per-project ChromaDB collection) → `clusters.calculate_coordinates_and_clusters` (mutates nodes in place with 3D coords + cluster ids). Orphaned files are cascade-deleted from both SQLite and Chroma. `project_id` is derived on the frontend by slugifying the workspace path.

### Retrieval (GraphRAG)

Chat/search queries run `ai_client.generate_hyde_document` (HyDE — generate a hypothetical answer to improve recall) → `embeddings.semantic_search` (per-project Chroma similarity) → relevant node content is injected into the LLM prompt. `APP_STATE["nodes"]` holds the full in-memory node set for search.

### AI routing (`backend/ai_client.py`)

Single routing layer for three provider classes: **local Ollama** (direct HTTP to `127.0.0.1:11434/api/generate`, streaming), **MLX** (Apple Silicon), and **cloud** via `litellm` (Claude/OpenAI/Gemini/Grok). `calculate_dynamic_timeout` scales the HTTP timeout by model parameter size (e.g. 7B → ~10 min, 70B → ~60 min) so large local models don't time out on heavy context.

### WebSocket channels (`backend/main.py`)

1.  `/api/brain/ws` → `brain_pipeline.handle_brain_websocket`: the **Copilot agent state machine**. The client sends `agent_mode` (`"plan"` | `"ask-permission"` | `"accept-edits"`): planning (`plan_blueprint` + blocking `plan_approval`) only happens in plan mode; in ask-permission mode each file write blocks on `edit_permission_request`/`edit_approval`; shell commands block on `cli_permission_request`/`cli_approval` in **every** mode. After each write the backend sends `file_written {path}` so the Studio reloads clean open tabs + refreshes the tree. Other streamed types: `state_change`, `task_update`, `chunk`, `walkthrough_chunk`.
2.  `/api/terminal/ws` → `terminal_manager`: a real PTY (`pty.fork`) shell, cwd-aware via `?cwd=`. Cross-platform shell selection (zsh/bash vs powershell/cmd).
3.  `/api/dap/ws` → `dap_manager`: a **generic DAP framing proxy**. First client message is `{"type":"cortexInit","ext":".py","program":...}`; the backend picks an adapter from its registry (Python → bundled debugpy over stdio; C/C++/Rust → `lldb-dap` if installed, with a `-g -O0` pre-compile step; Go → `dlv dap` over TCP), then relays plain DAP JSON ⇄ Content-Length-framed wire format. Missing adapters emit a `cortexDebugError` event (frontend toasts + falls back to terminal pdb/node-inspect). The proxy is adapter-agnostic — new languages are added by extending the registry in `dap_manager.py` only.

### Memory (`backend/memory_store.py`)

Persistent "Memory Ledger" via **mem0** (vectors in `mem0_chroma`, metadata in `mem0.db`). `process_memory_extraction` mines facts from chat turns; `get_core_directives` injects persisted persona/constraints into prompts; `compact_session_history` trims long histories. Uses the user's active local model for extraction.

### Generators

`ppt_generator.py` (python-pptx, themed decks + matplotlib charts), `pdf_generator.py` (fpdf2). The frontend can request native `.pdf`/`.pptx`/`.csv` exports; heavy jobs offload to `workers/airllm_worker.py` (async queue). `workers/voice_worker.py` + bundled `workers/whisper.cpp` handle voice transcription; `workers/predictive_engine.py` runs scikit-learn analytics.

### Storage layout (`backend/storage/`, overridable via `MINDPALACE_STORAGE_DIR`)

`cache.db` (incremental diff cache), `chroma_db/` (GraphRAG vectors), `mem0.db` + `mem0_chroma/` (memory ledger).

## Frontend (`frontend/`, vanilla JS)

Six **classic (non-module) scripts** load in order in `index.html`: `app-v12.js` (Immersive mode + 3D graph + chat + exports), `studio.js` (the Studio IDE: Monaco editor, multi-terminal, file tree, git, runner, tasks, Copilot panel), `debugger.js` (the DAP client: session lifecycle, floating debug toolbar, Debug Console/variables/call stack, stopped-line decorations), `richtext.js` (shared `window.DocEngine` + the IDE's Quill doc-tabs), `docstudio.js` (the Documents Editor + Deep Research surfaces), `menubar.js` (data-driven OS menu bar). Because they're classic scripts, top-level functions become globals — `menubar.js` and inline `onclick` handlers call functions defined in `studio.js`/`app-v12.js` by name, and `debugger.js` wraps `updateBreakpointsForModel` to live-sync breakpoints mid-session. **Cache-bust by bumping the** `**?v=N**` **query on** `**<script>**`**/**`**<link>**` **tags in** `**index.html**` **whenever you edit a JS/CSS asset.**

**Phase 7 — Omni-Document Studio (**`**richtext.js**`**):** the app is split into **three Studio surfaces** behind the "Switch to Studios ▾" dropdown — `window.switchSurface('ide'|'document'|'research'|'chat')` (studio.js) toggles `body.surface-*` classes and CSS slides one surface in. **Cortex IDE** opens on a blank editor and still opens `.md/.txt/.docx` as Quill tabs (router in `openWorkspaceFile`/`switchToTab`). `richtext.js` exposes **`window.DocEngine`** (md↔html, sanitize, `makeQuill`, a robust 30fps `createStream` SSE→Quill streamer, client/server export). **`docstudio.js`** builds the standalone **Documents Editor** (`#docstudio-editor`: intent modal + draft, Grammarly-style underlines via `/api/doc/grammar` + a `docsuggest` Quill blot, ghost-text via `/api/doc/complete`, open/save/export) and the **Deep Research** query screen (streams `/api/research` into a new doc). Backend: `backend/workers/research_agent.py` (DDGS→bs4 crawl→sklearn→`run_contextual_chat`), `backend/docx_generator.py` (python-docx+ReportLab) for `/api/export-doc`, file ops `/api/workspace/{rename,delete,move,copy,raw}` (all `_guard_path`-scoped), and the file-tree right-click menu (`showFileContextMenu`). DOMPurify sanitizes all markdown→HTML (`safeMd` in app-v12.js). Packaging: `launcher.py` → `cortex_backend.spec` (PyInstaller) → `src-tauri/` (Tauri sidecar); `scripts/build_installers.sh`.

**Phase 8 — Utilities Studio (**`**utilities.js**`**):** a **fourth surface** (`window.switchSurface('utilities')`, `body.surface-utilities`, `<main class="utilities-main">`) launched from a dedicated **🧰 Utilities header button** beside "Switch to Studios" (it is intentionally NOT in the Studios dropdown). The surface has just two lazy-initialized canvases: **Notes & Tasks** (`/api/tasks` CRUD) and **Email & Calendar** (`workers/comms_bridge.py`, **draft-only** — `/api/comms/{providers,parse,draft}`; OS-aware provider list with Gmail always via a browser compose URL, Apple Mail/Outlook via osascript/PowerShell unsent drafts, calendar via Google URL or a generated `.ics`; the Natural Intent Bar parses casual text→JSON through `run_contextual_chat`, parsed by the robust fence-stripping/field-regex `_extract_json` in `main.py`; **nothing is ever sent/saved autonomously**). The two **model tools live in the main chat left sidebar** (icons above the settings gear) and open as large modals via `window.openModelCookbook()` / `window.openModelCompare()`: **Model Cookbook** (`workers/cookbook.py` — psutil/torch hardware scan + Fit Score over a curated *current* Ollama catalog; fitting models → `/api/cookbook/pull` GET-SSE `ollama pull`; oversized `red` models are `serving:"deepthink"` and, when they carry an `hf_repo`, show a warning + **"Use in Deep Think"** which calls `window.armDeepThink(repo)` to route them through the AirLLM `/api/generate-deep-analysis` path instead of crashing the box), and **Model Compare** (`/api/compare` GET-SSE, **context-switching serialization** — model A runs to completion then B so a single GPU never holds both; blind anonymized+randomized columns, `/api/compare/vote` records to `compare_votes`). **Backend daemons** start once via a single `@app.on_event("startup")` in `main.py`: `workers/task_queue.py` (a `queue.Queue` + one daemon thread that owns ALL writes to the `tasks`/`compare_votes` SQLite tables — call `task_submit(op, payload)`; the no-`database is locked` serializer, **never write those tables directly**) and `workers/reminder_daemon.py` (30s poll → native desktop notification; one-shot reminders set `fired=1`, cron reminders advance `due_at` via the stdlib `cron_next` matcher). `requirements.txt` gained `psutil`. **`backend/embeddings.py` forces `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE`** at the top so the cached MiniLM model loads instantly with no network HEAD-check stalls (fast boot, works offline).

Key Studio subsystems (all in `studio.js` unless noted):

1.  **Menu bar** (`menubar.js`): rebuilds `#os-menu-bar` from a `MENUS` config. Edit/Selection/Go/View items map to Monaco built-in actions (`editor.getAction(id).run()`); others call `studio.js` globals. Dropdowns are CSS-hover (`.os-menu-item.has-dropdown`).
2.  **Code runner**: `getRunCommandForPath` maps ~45 file extensions → shell commands (interpreters run directly; compiled langs compile-then-run), injected into the active terminal via `injectTerminalCommand`. Relies on the user's installed toolchains.
3.  **Multi-terminal**: `window.terminalSessions[]`; `window.terminalWs`/`window.xtermTerminal` always alias the active session. Detached terminal popup = `frontend/terminal.html`. A `ResizeObserver` on `#terminal-container` calls `fitVisibleTerminals()` so term reflows on any layout change (sidebar drags etc.) — never rely on manual `fit()` calls alone.
4.  **Debugger** (`debugger.js`): F5 starts/continues (VS Code semantics; Cmd/Ctrl+F5 = run without debugging, F9 breakpoints, F10/F11/⇧F11 steps). Breakpoint keys in `window.ideBreakpoints` are `"<uri>:<line>"` — the URI contains colons, so always parse with `lastIndexOf(':')`.
5.  **Agent modes**: `window.agentMode` (`ask-permission` default | `accept-edits` | `plan`), persisted in localStorage, shown as the mode pill `#copilot-mode-btn`; sent as `agent_mode` in the brain ws payload.
6.  **Task system**: reads/writes `<workspace>/.cortex/tasks.json` via `GET /api/workspace/file` + `POST /api/workspace/save`.
7.  **Editor persistence**: `POST /api/workspace/save` persists buffers; tabs carry a `dirty` flag; Auto Save is opt-in.
8.  Shared UI helpers: `showToast(msg, type)`, `showQuickPick(title, items, onPick)`. Studio styles live in `studio.css`; Immersive styles in `style-v12.css`.

The backend serves `frontend/` at `/static` and `index.html` at `/` (with no-cache headers).
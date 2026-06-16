import json
import re
import uuid
import asyncio
from fastapi import WebSocket, WebSocketDisconnect
from backend.memory_store import get_core_directives, compact_session_history
from backend.embeddings import semantic_search
from backend.ai_client import run_contextual_chat

agent_sessions = {}
session_lock = asyncio.Lock()


def dynamic_context_budget(model: str):
    """Decide how much memory/codebase context to inject based on the model's
    weight RELATIVE to this machine's memory budget. A model that is heavy for
    the current hardware gets fewer/smaller chunks (faster prompt-eval); a light
    one gets richer context. Returns (max_chunks, max_chars). Works on any
    OS/hardware — degrades to a safe middle default if detection fails."""
    try:
        from backend.workers import cookbook
        hw = cookbook.scan_hardware()
        avail = cookbook._available_gb(hw) or 8.0
        m = re.search(r'(\d+(?:\.\d+)?)[bB]', model or "")
        params = float(m.group(1)) if m else 7.0
        model_gb = params * 0.6  # ≈ Q4 footprint
        ratio = model_gb / avail if avail > 0 else 1.0
    except Exception:
        ratio = 0.5
    if ratio >= 0.7:        # heavy for this machine → minimal context
        return 1, 900
    if ratio >= 0.35:       # medium
        return 2, 1600
    return 3, 2500          # light → modest context (kept lean for speed)

async def execute_terminal_command(command: str) -> str:
    """Executes a shell command asynchronously and limits output to 1000 chars."""
    process = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await process.communicate()
    
    out_str = stdout.decode('utf-8', errors='replace')
    err_str = stderr.decode('utf-8', errors='replace')
    
    combined = out_str + "\n" + err_str
    
    if len(combined) > 1000:
        truncated = combined[-1000:]
        return f"...[TRUNCATED: Showing last 1000 chars]...\n{truncated}"
    return combined

async def assemble_brain_context(prompt: str, ui_context: dict, project_id: str, model: str, skip_context: bool = False):
    loop = asyncio.get_event_loop()

    # Scale how much context we inject to the model's weight vs this machine —
    # a 27B that's heavy here gets fewer chunks (fast); a light 8B gets more.
    max_chunks, max_chars = dynamic_context_budget(model)
    per_chunk = max(600, max_chars // max(1, max_chunks))

    async def fetch_l1():
        return await loop.run_in_executor(None, get_core_directives)

    async def fetch_l2():
        # Generation tasks (PPT/PDF/CSV/visualize) are topic-generation, not
        # questions about the workspace — injecting project code here derails
        # them. Skip the RAG lookup entirely when the caller opts out.
        if skip_context:
            return ""
        results = await loop.run_in_executor(None, semantic_search, prompt, None, 10, project_id)
        # Results is usually a list of dicts or dict with 'results'
        if isinstance(results, dict) and "results" in results:
            results = results["results"]
        if not results:
            return ""
        nodes = []
        for r in results[:max_chunks]:
            if isinstance(r, dict):
                content = r.get("content", "")
                if content:
                    nodes.append(str(content)[:per_chunk])
            else:
                nodes.append(str(r)[:per_chunk])
        # Bound the total codebase context so prompt-eval stays fast.
        return "\n\n".join(nodes)[:max_chars]

    l1_rules, l2_codebase = await asyncio.gather(fetch_l1(), fetch_l2())

    l3_ui = f"Active File: {ui_context.get('active_file_path', 'None')}\nSelected Text: {str(ui_context.get('selected_text', 'None'))[:2000]}"

    # Label the retrieved chunks explicitly as the user's mapped project so even
    # smaller models recognise them as "the project" instead of dismissing them.
    project_block = (f"## Files from the user's currently-mapped project "
                     f"(use these to answer questions about the project/codebase):\n{l2_codebase}"
                     if l2_codebase.strip() else "")

    return f"{l1_rules}\n\n{project_block}\n\nUI Context:\n{l3_ui}\n\nUser Query: {prompt}"


async def run_agent_state_machine(ws: WebSocket, session_id: str, prompt: str, context_string: str, model: str, ui_context: dict, agent_mode: str = "ask-permission", api_key: str = ""):
    """agent_mode controls planning + edit gating:
      - "plan":           generate a plan blueprint and wait for approval before executing
      - "ask-permission": skip planning; each file write requires user approval
      - "accept-edits":   skip planning; file writes are applied immediately
    Shell commands are permission-gated in every mode."""
    import os
    async with session_lock:
        session = agent_sessions[session_id]
        session["history"].append({"role": "user", "content": prompt})

    if agent_mode == "plan":
        async with session_lock:
            session["state"] = "PLANNING"
            session["plan_approved"] = False

        # State 1: Planning Blueprint
        system_plan_prompt = """You are an autonomous coding agent planning a sequence of tasks.
Analyze the request and output a strict JSON array roadmap matching this schema:
{
  "plan_summary": "Overall plan description",
  "tasks": ["Task 1 description as a string", "Task 2 description as a string"],
  "agent_questions": ["Any clarifications needed?"]
}
Only return valid JSON."""

        # We use run_contetual_chat for generation
        plan_generator = run_contextual_chat(prompt, context_string, provider=model, api_key=api_key, system_prompt=system_plan_prompt)
        plan_text = ""
        async for chunk in plan_generator:
            plan_text += chunk

        # Extract JSON
        try:
            import re
            json_match = re.search(r'\{.*\}', plan_text, re.DOTALL)
            if json_match:
                plan_json = json.loads(json_match.group(0))
            else:
                plan_json = json.loads(plan_text)
        except Exception:
            # Fallback plan
            plan_json = {
                "plan_summary": "Proceeding with execution based on prompt.",
                "tasks": ["Execute request"],
                "agent_questions": []
            }

        await ws.send_json({"type": "plan_blueprint", "plan": plan_json})

        # Wait for plan approval
        while True:
            await asyncio.sleep(0.5)
            async with session_lock:
                if session.get("plan_approved"):
                    break

        # State 2: Bidirectional Injection
        async with session_lock:
            feedback = session.get("human_feedback", "")
            if feedback:
                session["history"].append({"role": "user", "content": f"User Feedback/Constraints: {feedback}"})
            session["state"] = "EXECUTING"
    else:
        # Ask-permission / accept-edits: no upfront plan, go straight to work
        async with session_lock:
            session["state"] = "EXECUTING"

    await ws.send_json({"type": "state_change", "state": "EXECUTING"})
    
    # State 3: Execution UI Sync (Loop)
    MAX_STEPS = 6
    history_context = context_string
    
    for step in range(MAX_STEPS):
        # Stop button: bail out of the execution loop if the client cancelled.
        async with session_lock:
            if agent_sessions.get(session_id, {}).get("cancelled"):
                agent_sessions[session_id]["cancelled"] = False
                await ws.send_json({"type": "chunk", "content": "\n\n🛑 Stopped by user."})
                await ws.send_json({"type": "state_change", "state": "COMPLETED"})
                await ws.send_json({"type": "walkthrough_done"})
                return

        await ws.send_json({"type": "task_update", "status": "running", "step": step+1, "total": MAX_STEPS})

        tool_prompt = f"""You are an autonomous coding agent executing Step {step+1} of your plan.
Your history: {history_context[-8000:]}

IMPORTANT RULES:
- If you need to edit a file, use the action WRITE_FILE with the EXACT absolute path of the file from the context.
- Do NOT use placeholder paths like "/path/to/file.c". Use the real path.
- Provide the FULL content of the file in the "content" field.

You MUST respond in STRICT JSON format matching EXACTLY this schema:
{{
  "thought": "Your reasoning for the net action",
  "action": "one of: WRITE_FILE, RUN_COMMAND, FINISHED",
  "file_path": "absolute path (if WRITE_FILE)",
  "content": "file contents (if WRITE_FILE)",
  "command": "shell command (if RUN_COMMAND)",
  "summary": "completion summary (if FINISHED)"
}}

CRITICAL: ONLY use the "FINISHED" action when ALL steps in your ENTIRE plan are 100% complete and there is absolutely nothing left to do. Do NOT use "FINISHED" just to end the current step."""
        
        step_gen = run_contextual_chat(prompt, "", provider=model, api_key=api_key, system_prompt=tool_prompt)
        step_text = ""
        
        # Stream a friendly loading message instead of raw JSON
        await ws.send_json({"type": "chunk", "content": f"\n\n⚙️ **Working on Step {step+1}**"})
        
        chunk_count = 0
        async for chunk in step_gen:
            step_text += chunk
            chunk_count += 1
            if chunk_count % 10 == 0:
                await ws.send_json({"type": "chunk", "content": "."})
            
        await ws.send_json({"type": "chunk", "content": " ✅\n"})
        
        try:
            import re
            json_match = re.search(r'\{.*\}', step_text, re.DOTALL)
            action_json = json.loads(json_match.group(0)) if json_match else json.loads(step_text)
            action_type = action_json.get("action", "FINISHED")
        except:
            # If parsing fails, don't just finish, log the text and continue trying
            history_context += f"\n[Step {step+1} Error]: Failed to parse JSON. Model output: {step_text[:200]}"
            continue
            
        if action_type == "FINISHED":
            break
            
        elif action_type in ["WRITE_FILE", "MODIFY_CODE"]:
            file_path = action_json.get("file_path", "")
            content = action_json.get("content", "")
            
            # Force absolute path if hallucinated by model
            if file_path and ui_context:
                active_path = ui_context.get("active_file_path")
                workspace_dir = ui_context.get("workspace_dir")
                
                if active_path and ("/path/" in file_path or not file_path.startswith("/") or os.path.basename(file_path) == os.path.basename(active_path)):
                    file_path = active_path
                elif workspace_dir and not file_path.startswith(workspace_dir):
                    # If it's still a relative or weird path, resolve against workspace
                    file_path = os.path.join(workspace_dir, os.path.basename(file_path))
                    
            if file_path:
                # In ask-permission mode every file write needs user approval
                # (mirrors the RUN_COMMAND permission gate below).
                if agent_mode == "ask-permission":
                    preview_lines = content.splitlines()
                    preview = "\n".join(preview_lines[:40])
                    async with session_lock:
                        session["state"] = "AWAITING_EDIT_PERMISSION"
                        session["pending_edit_approved"] = False
                        session["pending_edit_rejected"] = False

                    await ws.send_json({
                        "type": "edit_permission_request",
                        "path": file_path,
                        "content_preview": preview,
                        "total_lines": len(preview_lines)
                    })

                    edit_approved = False
                    while True:
                        await asyncio.sleep(0.5)
                        async with session_lock:
                            if session.get("pending_edit_approved"):
                                edit_approved = True
                                break
                            if session.get("pending_edit_rejected"):
                                break

                    async with session_lock:
                        session["state"] = "EXECUTING"

                    if not edit_approved:
                        history_context += f"\n[Step {step+1} Edit]: {file_path}\n[Output]: Error: User denied permission to modify this file."
                        continue

                try:
                    os.makedirs(os.path.dirname(os.path.abspath(file_path)), exist_ok=True)
                    with open(file_path, "w", encoding="utf-8") as f:
                        f.write(content)
                    history_context += f"\n[Step {step+1} Result]: Wrote {len(content)} chars to {file_path}"
                    # Let open editors / the file tree refresh live
                    await ws.send_json({"type": "file_written", "path": file_path})
                except Exception as e:
                    history_context += f"\n[Step {step+1} Error]: {str(e)}"
                    
        elif action_type == "RUN_COMMAND":
            command = action_json.get("command", "")
            if command:
                async with session_lock:
                    session["state"] = "AWAITING_CLI_PERMISSION"
                    session["pending_command_approved"] = False
                    session["pending_command_rejected"] = False
                    
                await ws.send_json({"type": "cli_permission_request", "command": command})
                
                # Wait for approval
                approved = False
                while True:
                    await asyncio.sleep(0.5)
                    async with session_lock:
                        if session.get("pending_command_approved"):
                            approved = True
                            break
                        if session.get("pending_command_rejected"):
                            break
                
                async with session_lock:
                    session["state"] = "EXECUTING"
                    
                if approved:
                    out = await execute_terminal_command(command)
                    history_context += f"\n[Step {step+1} Command]: {command}\n[Output]: {out}"
                else:
                    history_context += f"\n[Step {step+1} Command]: {command}\n[Output]: Error: User explicitly denied permission to run this command."

    # State 5: Completion Walkthrough
    async with session_lock:
        session["state"] = "COMPLETED"
    
    await ws.send_json({"type": "state_change", "state": "COMPLETED"})
    walkthrough_prompt = "You are an autonomous coding agent. Summarize the work done as a final walkthrough. Do not mention data analysis."
    walkthrough_generator = run_contextual_chat("Summarize the work done.", history_context, provider=model, api_key=api_key, system_prompt=walkthrough_prompt)
    async for chunk in walkthrough_generator:
        await ws.send_json({"type": "walkthrough_chunk", "content": chunk})
        
    await ws.send_json({"type": "walkthrough_done"})


async def handle_brain_websocket(ws: WebSocket):
    await ws.accept()
    session_id = str(uuid.uuid4())
    
    async with session_lock:
        agent_sessions[session_id] = {
            "state": "IDLE",
            "history": [],
            "pending_command": None,
            "tasks": [],
            "plan_approved": False,
            "human_feedback": ""
        }
        
    try:
        while True:
            data = await ws.receive_json()
            
            msg_type = data.get("type", "message")
            
            if msg_type == "cli_approval":
                async with session_lock:
                    session = agent_sessions[session_id]
                    if session["state"] == "AWAITING_CLI_PERMISSION":
                        session["pending_command_approved"] = data.get("approved", False)
                        session["pending_command_rejected"] = not session["pending_command_approved"]
                continue

            if msg_type == "edit_approval":
                async with session_lock:
                    session = agent_sessions[session_id]
                    if session["state"] == "AWAITING_EDIT_PERMISSION":
                        session["pending_edit_approved"] = data.get("approved", False)
                        session["pending_edit_rejected"] = not session["pending_edit_approved"]
                continue

            if msg_type == "plan_approval":
                async with session_lock:
                    session = agent_sessions[session_id]
                    if session["state"] == "PLANNING":
                        session["plan_approved"] = True
                        session["human_feedback"] = data.get("feedback", "")
                continue

            if msg_type == "cancel":
                # Stop button: flag the running agent state machine to bail out.
                async with session_lock:
                    if session_id in agent_sessions:
                        agent_sessions[session_id]["cancelled"] = True
                continue

            mode = data.get("interaction_mode", "ask")
            model = data.get("model") or "local"  # ai_client resolves bare "local" to an installed model
            api_key = data.get("api_key", "")
            prompt = data.get("prompt", "")
            ui_context = data.get("ui_context", {})
            project_id = data.get("project_id", "default")
            frontend_context = data.get("context", "")
            images = data.get("images") or []  # base64 images for vision models
            skip_context = data.get("skip_context", False)  # generation modes opt out of RAG

            context_string = await assemble_brain_context(prompt, ui_context, project_id, model, skip_context=skip_context)
            if not skip_context and frontend_context and frontend_context != "General Knowledge Query":
                # Clip the frontend-provided RAG context to the same hardware/
                # model-aware budget so a heavy model isn't slowed by a big prompt.
                _, _max_chars = dynamic_context_budget(model)
                context_string = f"{context_string}\n\nSearch Context:\n{str(frontend_context)[:_max_chars]}"
            
            if mode == "ask":
                process_task = None
                send_lock = asyncio.Lock()
                
                async def keep_alive():
                    try:
                        while True:
                            await asyncio.sleep(2)
                            async with send_lock:
                                await ws.send_json({"type": "chunk", "content": ""})
                    except (asyncio.CancelledError, RuntimeError, Exception):
                        if process_task and not process_task.done():
                            process_task.cancel()
                
                keep_alive_task = asyncio.create_task(keep_alive())
                
                async def run_chat():
                    generator = run_contextual_chat(prompt, context_string, provider=model, api_key=api_key, images=images)
                    try:
                        async for chunk in generator:
                            if chunk:
                                async with send_lock:
                                    await ws.send_json({"type": "chunk", "content": chunk})
                        async with send_lock:
                            await ws.send_json({"type": "done"})
                    except (RuntimeError, WebSocketDisconnect, Exception):
                        pass
                        
                process_task = asyncio.create_task(run_chat())

                # Race the generation against incoming ws messages so a client
                # {"type":"cancel"} (the IDE/main-chat stop button) actually
                # breaks the loop and frees the model instead of the next prompt
                # queueing behind a still-running 27B.
                try:
                    while not process_task.done():
                        recv_task = asyncio.create_task(ws.receive_json())
                        done, _ = await asyncio.wait(
                            {process_task, recv_task},
                            return_when=asyncio.FIRST_COMPLETED)
                        if recv_task in done:
                            try:
                                incoming = recv_task.result()
                            except Exception:
                                incoming = None
                            if incoming and incoming.get("type") == "cancel":
                                process_task.cancel()
                                break
                            # Ignore any other mid-generation message.
                        else:
                            recv_task.cancel()
                    await asyncio.gather(process_task, return_exceptions=True)
                except asyncio.CancelledError:
                    pass
                finally:
                    keep_alive_task.cancel()
                
            elif mode == "suggest":
                generator = run_contextual_chat("Provide inline code diff suggestions. " + prompt, context_string, provider=model, api_key=api_key)
                try:
                    async for chunk in generator:
                        if chunk:
                            await ws.send_json({"type": "chunk", "content": chunk})
                    await ws.send_json({"type": "done"})
                except (RuntimeError, WebSocketDisconnect):
                    pass
                
            elif mode == "agent":
                agent_mode = data.get("agent_mode", "ask-permission")
                asyncio.create_task(run_agent_state_machine(ws, session_id, prompt, context_string, model, ui_context, agent_mode, api_key))
                
    except WebSocketDisconnect:
        print(f"Brain WebSocket disconnected for session {session_id}")
    finally:
        async with session_lock:
            if session_id in agent_sessions:
                del agent_sessions[session_id]

import asyncio
import json
import os
import shutil
import socket
import sys
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _find_lldb_dap():
    for name in ("lldb-dap", "lldb-vscode"):
        path = shutil.which(name)
        if path:
            return path
    # Xcode toolchains ship it without putting it on PATH
    for candidate in (
        "/Library/Developer/CommandLineTools/usr/bin/lldb-dap",
        "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.ctoolchain/usr/bin/lldb-dap",
    ):
        if os.path.exists(candidate):
            return candidate
    return None


# Compile step for natively-debugged languages: (compiler, etra flags).
# The binary is built next to the source as <name>_debug with -g -O0.
_C_FAMILY = {
    ".c":   ("gcc", []),
    ".cpp": ("g++", []),
    ".cc":  ("g++", []),
    ".c": ("g++", []),
    ".m":   ("clang", ["-framework", "Foundation"]),
    ".rs":  ("rustc", []),
}


class DAPSession:
    """
    One debug session per WebSocket: spawns the right DAP adapter for the
    file's language and proxies messages between the WS (plain DAP JSON)
    and the adapter (Content-Length framed, over stdio or TCP).
    """

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.proc = None
        self.reader = None          # adapter -> us
        self.writer = None          # us -> adapter (TCP only; stdio uses proc.stdin)
        self.transport = "stdio"
        self.ext = None
        self.program = None
        self.pump_task = None

    # ---------- adapter resolution ----------

    async def _send_error(self, message: str, hint: str = ""):
        await self.ws.send_text(json.dumps({
            "type": "event",
            "event": "cortexDebugError",
            "body": {"message": message, "hint": hint},
        }))

    async def _send_output(self, text: str, category: str = "console"):
        await self.ws.send_text(json.dumps({
            "type": "event",
            "event": "output",
            "body": {"category": category, "output": text},
        }))

    async def start(self, ext: str, program: str) -> bool:
        """Resolve + spawn the adapter for this file type. Returns False (after
        emitting cortexDebugError) when no adapter is available — the frontend
        falls back to its terminal CLI debuggers."""
        self.ext = ext = (ext or "").lower()
        self.program = program

        if ext == ".py":
            try:
                import debugpy  # noqa: F401
            except ImportError:
                await self._send_error(
                    "Python debugging needs the 'debugpy' package in the Cortex backend.",
                    "pip install debugpy")
                return False
            return await self._spawn_stdio([sys.executable, "-m", "debugpy.adapter"])

        if ext in _C_FAMILY:
            adapter = _find_lldb_dap()
            if not adapter:
                await self._send_error(
                    f"No debug adapter found for '{ext}' files (lldb-dap is not installed).",
                    "Install the Xcode Command Line Tools (macOS) or LLVM's lldb-dap.")
                return False
            binary = await self._compile_native(program)
            if not binary:
                return False
            self.program = binary
            return await self._spawn_stdio([adapter])

        if ext == ".go":
            dlv = shutil.which("dlv")
            if not dlv:
                await self._send_error(
                    "No debug adapter found for Go (delve is not installed).",
                    "go install github.com/go-delve/delve/cmd/dlv@latest")
                return False
            return await self._spawn_tcp([dlv, "dap", "--listen"])

        await self._send_error(
            f"Visual debugging is not available for '{ext}' files yet.",
            "Python (built-in), C/C++/Rust (lldb-dap) and Go (delve) are supported.")
        return False

    async def _compile_native(self, program: str):
        compiler_name, extra = _C_FAMILY[self.ext]
        compiler = shutil.which(compiler_name) or shutil.which("clang" if compiler_name != "rustc" else "rustc")
        if not compiler:
            await self._send_error(
                f"Compiler '{compiler_name}' not found — cannot build a debug binary for {os.path.basename(program)}.")
            return None
        out = os.path.join(os.path.dirname(program),
                           os.path.splitext(os.path.basename(program))[0] + "_debug")
        if self.ext == ".rs":
            cmd = [compiler, "-g", program, "-o", out]
        else:
            cmd = [compiler, "-g", "-O0", program, "-o", out] + extra
        await self._send_output(f"Compiling for debug: {' '.join(cmd)}\n")
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await proc.communicate()
        if stdout:
            await self._send_output(stdout.decode(errors="replace"))
        if stderr:
            await self._send_output(stderr.decode(errors="replace"), "stderr")
        if proc.returncode != 0:
            await self._send_error(f"Debug build failed (exit {proc.returncode}).")
            return None
        return out

    # ---------- adapter spawning ----------

    async def _spawn_stdio(self, cmd) -> bool:
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
        except Exception as e:
            await self._send_error(f"Failed to start debug adapter: {e}")
            return False
        self.transport = "stdio"
        self.reader = self.proc.stdout
        self.pump_task = asyncio.create_task(self._pump_adapter_to_ws())
        return True

    async def _spawn_tcp(self, cmd_without_addr) -> bool:
        port = _free_port()
        addr = f"127.0.0.1:{port}"
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *cmd_without_addr, addr,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL)
        except Exception as e:
            await self._send_error(f"Failed to start debug adapter: {e}")
            return False
        self.transport = "tcp"
        for _ in range(50):  # wait for the adapter to listen (max ~5s)
            try:
                self.reader, self.writer = await asyncio.open_connection("127.0.0.1", port)
                break
            except OSError:
                await asyncio.sleep(0.1)
        else:
            await self._send_error("Debug adapter did not start listening.")
            await self.close()
            return False
        self.pump_task = asyncio.create_task(self._pump_adapter_to_ws())
        return True

    # ---------- framing proxy ----------

    async def _pump_adapter_to_ws(self):
        try:
            while True:
                content_length = 0
                while True:
                    line = await self.reader.readline()
                    if not line:
                        return  # adapter eited
                    line = line.strip()
                    if not line:
                        break  # end of headers
                    if line.lower().startswith(b"content-length:"):
                        content_length = int(line.split(b":")[1])
                if content_length <= 0:
                    continue
                body = await self.reader.readexactly(content_length)
                await self.ws.send_text(body.decode("utf-8", errors="replace"))
        except (asyncio.IncompleteReadError, asyncio.CancelledError, RuntimeError,
                ConnectionResetError, WebSocketDisconnect):
            pass

    def _write_to_adapter(self, msg: dict):
        body = json.dumps(msg).encode("utf-8")
        frame = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body
        if self.transport == "tcp":
            if self.writer:
                self.writer.write(frame)
        else:
            if self.proc and self.proc.stdin:
                self.proc.stdin.write(frame)

    # ---------- launch shim ----------

    def _prepare_launch(self, msg: dict) -> dict:
        args = msg.setdefault("arguments", {})
        args.setdefault("program", self.program)
        program = args.get("program") or self.program or ""
        args.setdefault("cwd", os.path.dirname(program) or os.getcwd())

        if self.ext == ".py":
            args.setdefault("python", shutil.which("python3") or sys.executable)
            args.setdefault("console", "internalConsole")
            args.setdefault("redirectOutput", True)
            args.setdefault("justMyCode", True)
        elif self.ext in _C_FAMILY:
            # lldb-dap debugs the compiled binary, not the source file
            args["program"] = self.program
        elif self.ext == ".go":
            args.setdefault("mode", "debug")
            args["program"] = self.program
        return msg

    # ---------- session loop ----------

    async def run(self):
        """Main receive loop. First message must be
        {"type": "cortexInit", "ext": ".py", "program": "/abs/path"}."""
        init = await self.ws.receive_json()
        if init.get("type") != "cortexInit":
            await self._send_error("Protocol error: expected cortexInit as the first message.")
            return
        if not await self.start(init.get("ext", ""), init.get("program", "")):
            return
        await self.ws.send_text(json.dumps({"type": "event", "event": "cortexReady", "body": {}}))

        while True:
            msg = await self.ws.receive_json()
            if msg.get("type") == "request" and msg.get("command") == "launch":
                msg = self._prepare_launch(msg)
            self._write_to_adapter(msg)

    async def close(self):
        try:
            if self.proc and self.proc.returncode is None:
                try:
                    self._write_to_adapter({
                        "seq": 0, "type": "request", "command": "disconnect",
                        "arguments": {"terminateDebuggee": True},
                    })
                except Exception:
                    pass
                try:
                    self.proc.terminate()
                    await asyncio.wait_for(self.proc.wait(), timeout=3)
                except (asyncio.TimeoutError, ProcessLookupError):
                    try:
                        self.proc.kill()
                    except ProcessLookupError:
                        pass
        except Exception as e:
            print(f"DAP cleanup error: {e}")
        if self.pump_task:
            self.pump_task.cancel()
        if self.writer:
            try:
                self.writer.close()
            except Exception:
                pass


class DAPManager:
    """Routes each /api/dap/ws connection to its own DAPSession."""

    def __init__(self):
        self.sessions = {}

    async def handle_websocket(self, ws: WebSocket):
        await ws.accept()
        session = DAPSession(ws)
        self.sessions[id(ws)] = session
        try:
            await session.run()
        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"DAP WS Error: {e}")
        finally:
            await session.close()
            self.sessions.pop(id(ws), None)


dap_manager = DAPManager()

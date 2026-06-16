import os
import pty
import fcntl
import termios
import struct
import asyncio
import signal
import platform
import shutil
from fastapi import WebSocket, WebSocketDisconnect

class TerminalManager:
    def __init__(self):
        self.terminals = {}

    async def handle_websocket(self, ws: WebSocket, cwd: str = None):
        await ws.accept()
        
        # Create pseudo-terminal
        pid, fd = pty.fork()
        
        if pid == 0:
            # Child process
            if cwd and os.path.exists(cwd):
                try:
                    os.chdir(cwd)
                except Exception:
                    pass
            os.environ["TERM"] = "xterm-256color"
            
            # Dynamic shell check
            if platform.system() == "Windows":
                fallback_shell = shutil.which("powershell.exe") or shutil.which("cmd.exe") or "cmd.exe"
            else:
                fallback_shell = shutil.which("zsh") or shutil.which("bash") or "/bin/sh"
                
            shell = os.environ.get("SHELL", fallback_shell)
            if platform.system() == "Windows":
                os.execv(shell, [shell])
            else:
                os.execv(shell, [shell, "-l"])
        else:
            # Parent process
            # Set non-blocking
            flags = fcntl.fcntl(fd, fcntl.F_GETFL)
            fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
            
            self.terminals[ws] = {"fd": fd, "pid": pid, "loop": asyncio.get_running_loop()}
            
            def read_from_pty():
                try:
                    data = os.read(fd, 4096)
                    if data:
                        # Send to websocket
                        asyncio.create_task(ws.send_text(data.decode('utf-8', errors='replace')))
                except BlockingIOError:
                    pass
                except OSError:
                    self.cleanup(ws)

            # Register fd reader
            self.terminals[ws]["loop"].add_reader(fd, read_from_pty)
            
            try:
                while True:
                    msg = await ws.receive_json()
                    if msg.get("type") == "input":
                        data = msg.get("data", "")
                        os.write(fd, data.encode('utf-8'))
                    elif msg.get("type") == "resize":
                        cols = msg.get("cols", 80)
                        rows = msg.get("rows", 24)
                        winsize = struct.pack("HHHH", rows, cols, 0, 0)
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
            except WebSocketDisconnect:
                print("Terminal WebSocket disconnected")
                self.cleanup(ws)
            except Exception as e:
                print(f"Terminal WS error: {e}")
                self.cleanup(ws)

    def cleanup(self, ws: WebSocket):
        if ws in self.terminals:
            xterm = self.terminals[ws]
            pid = xterm["pid"]
            fd = xterm["fd"]
            loop = xterm["loop"]
            
            # 1. Remove reader
            try:
                loop.remove_reader(fd)
            except Exception:
                pass
            
            # 2. Kill the process strictly to prevent zombies
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception as e:
                print(f"Error sending SIGTERM: {e}")
                
            # Wait for it, fallback to SIGKILL (blocking, but fast)
            try:
                _, status = os.waitpid(pid, os.WNOHANG)
                if status == 0:
                    # Still alive
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
            except Exception:
                pass
                
            # 3. Close file descriptor
            try:
                os.close(fd)
            except OSError:
                pass
                
            del self.terminals[ws]

terminal_manager = TerminalManager()

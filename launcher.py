"""Cortex IDE — packaged-app entry point.

Runs the FastAPI backend with uvicorn. Used two ways:
  1. As the PyInstaller-bundled sidecar binary that the Tauri shell spawns
     (it just serves; Tauri opens the webview).
  2. Standalone (`python launcher.py`) — serves AND opens the default browser,
     so the app works with zero terminal interaction even without Tauri.

Honours $CORTEX_PORT (default 8077) and $CORTEX_NO_BROWSER (set by Tauri so we
don't pop a browser tab in front of the native window).
"""
import os
import sys
import threading
import webbrowser


def _resource_root() -> str:
    # When frozen by PyInstaller, data files live under sys._MEIPASS.
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def main():
    # Make `backend` importable whether frozen or run from source.
    root = _resource_root()
    if root not in sys.path:
        sys.path.insert(0, root)

    port = int(os.environ.get("CORTEX_PORT", "8077"))
    host = os.environ.get("CORTEX_HOST", "127.0.0.1")

    import uvicorn
    from backend.main import app  # noqa: E402  (import after path setup)

    if not os.environ.get("CORTEX_NO_BROWSER"):
        url = f"http://{host}:{port}/"
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()

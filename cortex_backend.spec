# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — bundles the Cortex IDE backend + frontend into a single
self-contained binary (`cortex-backend`) that the Tauri shell launches as a
sidecar. Build:  pyinstaller cortex_backend.spec

The heavy ML stack (chromadb, sentence-transformers, litellm, torch …) needs
explicit collection; the frontend and whisper.cpp assets ship as data so the
app runs fully offline with zero terminal interaction.
"""
from PyInstaller.utils.hooks import collect_all, collect_submodules
import os

block_cipher = None
PROJECT = os.path.abspath(os.getcwd())

datas = [
    ('frontend', 'frontend'),
    ('backend/workers/whisper.cpp', 'backend/workers/whisper.cpp'),
]
binaries = []
hiddenimports = []

# Collect packages PyInstaller can't trace statically.
for pkg in ('chromadb', 'sentence_transformers', 'litellm', 'duckduckgo_search',
            'mem0', 'docx', 'pptx', 'reportlab', 'bs4', 'readability', 'sklearn',
            'transformers', 'tokenizers', 'debugpy'):
    try:
        d, b, h = collect_all(pkg)
        datas += d; binaries += b; hiddenimports += h
    except Exception as e:
        print(f"[spec] skip {pkg}: {e}")

hiddenimports += collect_submodules('backend')
hiddenimports += ['uvicorn', 'uvicorn.logging', 'uvicorn.loops.auto',
                  'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets.auto',
                  'uvicorn.lifespan.on']

a = Analysis(
    ['launcher.py'],
    pathex=[PROJECT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib.tests', 'tensorflow'],
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name='cortex-backend',
    debug=False,
    strip=False,
    upx=False,
    console=True,   # Tauri hides it; keep stdout for logs during dev
)
coll = COLLECT(
    exe, a.binaries, a.datas,
    strip=False, upx=False, name='cortex-backend',
)

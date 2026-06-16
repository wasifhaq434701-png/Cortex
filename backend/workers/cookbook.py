"""
Phase 8 — Model Cookbook: hardware-aware serving recommendations.

Scans the machine (psutil RAM/CPU + torch CUDA/MPS) and scores a curated
catalog of Ollama models by how well they fit the available memory ("Fit
Score"). Serving is Ollama-only — recommendations are `ollama pull` tags, never
raw GGUF URLs.
"""

import re
import time
import platform


_hw_cache = {}


def scan_hardware():
    """Return a hardware summary dict. Best-effort; degrades if torch absent.
    Cached — hardware doesn't change during a session, and this is called on
    every chat turn (dynamic context budget), so re-probing psutil/torch each
    time would add needless latency."""
    if _hw_cache:
        return _hw_cache
    info = {"ram_gb": 0.0, "cpu_cores": 0, "gpu": "", "vram_gb": 0.0, "mps": False}
    try:
        import psutil
        info["ram_gb"] = round(psutil.virtual_memory().total / (1024 ** 3), 1)
        info["cpu_cores"] = psutil.cpu_count(logical=True) or 0
    except Exception:
        pass
    try:
        import torch
        if torch.cuda.is_available():
            info["gpu"] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            info["vram_gb"] = round(props.total_memory / (1024 ** 3), 1)
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            info["mps"] = True
            info["gpu"] = "Apple Silicon (MPS, unified memory)"
    except Exception:
        pass
    if not info["gpu"]:
        info["gpu"] = platform.processor() or "CPU"
    _hw_cache.update(info)
    return _hw_cache


# Curated catalog of STABLE, reliably-`ollama pull`-able tags (no bleeding-edge
# models whose manifests need a newer Ollama and 412 on download). `gb` ≈ the
# memory footprint to serve the default Q4 quant. Huge entries carry `hf_repo`
# so they route to the AirLLM Deep Think engine instead of a direct pull.
CATALOG = [
    # — Tiny / fast —
    {"model": "qwen2.5:0.5b", "params": "0.5B", "gb": 0.6, "note": "Tiny, instant — great for quick tasks"},
    {"model": "gemma3:1b", "params": "1B", "gb": 0.9, "note": "Small Gemma 3 — fast"},
    {"model": "llama3.2:1b", "params": "1B", "gb": 1.3, "note": "Fast, very low memory"},
    {"model": "qwen2.5:3b", "params": "3B", "gb": 2.0, "note": "Capable small general model"},
    {"model": "llama3.2:3b", "params": "3B", "gb": 2.2, "note": "Balanced everyday assistant"},
    {"model": "gemma3:4b", "params": "4B", "gb": 3.3, "note": "Strong small multimodal-class model · 👁 vision"},
    # — Everyday 7-9B —
    {"model": "mistral:7b", "params": "7B", "gb": 4.4, "note": "Reliable general-purpose 7B"},
    {"model": "qwen2.5:7b", "params": "7B", "gb": 4.7, "note": "Excellent general 7B"},
    {"model": "qwen2.5-coder:7b", "params": "7B", "gb": 4.7, "note": "Code-specialized 7B"},
    {"model": "deepseek-r1:7b", "params": "7B", "gb": 4.7, "note": "Reasoning-tuned (chain-of-thought)"},
    {"model": "llava:7b", "params": "7B", "gb": 4.5, "note": "Vision + chat · 👁 describes images"},
    {"model": "llama3.1:8b", "params": "8B", "gb": 4.9, "note": "Popular high-quality 8B"},
    {"model": "deepseek-r1:8b", "params": "8B", "gb": 5.2, "note": "Reasoning-tuned 8B"},
    # — Mid 12-14B —
    {"model": "gemma3:12b", "params": "12B", "gb": 8.1, "note": "Mid-size Gemma 3"},
    {"model": "llava:13b", "params": "13B", "gb": 8.0, "note": "Larger vision model · 👁"},
    {"model": "phi4:14b", "params": "14B", "gb": 9.1, "note": "Microsoft Phi-4 — strong reasoning"},
    {"model": "qwen2.5:14b", "params": "14B", "gb": 9.0, "note": "Stronger reasoning, needs headroom"},
    {"model": "deepseek-r1:14b", "params": "14B", "gb": 9.0, "note": "Mid reasoning model"},
    # — Large 27-32B (desktop/workstation memory) —
    {"model": "gemma3:27b", "params": "27B", "gb": 17.0, "note": "Large — desktop-class memory"},
    {"model": "qwen2.5:32b", "params": "32B", "gb": 20.0, "note": "Big — workstation memory"},
    {"model": "deepseek-r1:32b", "params": "32B", "gb": 20.0, "note": "Large reasoning model"},
    # — Frontier (too big to serve directly → Deep Think / AirLLM) —
    {"model": "llama3.3:70b", "params": "70B", "gb": 43.0,
     "note": "Frontier-class — too big to serve directly",
     "hf_repo": "meta-llama/Llama-3.3-70B-Instruct"},
    {"model": "qwen2.5:72b", "params": "72B", "gb": 47.0,
     "note": "Frontier-class — too big to serve directly",
     "hf_repo": "Qwen/Qwen2.5-72B-Instruct"},
    {"model": "deepseek-r1:70b", "params": "70B", "gb": 43.0,
     "note": "Frontier reasoning — too big to serve directly",
     "hf_repo": "deepseek-ai/DeepSeek-R1-Distill-Llama-70B"},
]


def get_ollama_version():
    """Return the installed Ollama version string (e.g. '0.5.7') or '' if it
    can't be reached. Used to warn that newer models may need an update."""
    try:
        import requests
        r = requests.get("http://localhost:11434/api/version", timeout=3)
        return r.json().get("version", "") or ""
    except Exception:
        return ""


_latest_ver_cache = {"ts": 0.0, "ver": ""}


def get_latest_ollama_version():
    """Latest released Ollama version from GitHub (e.g. '0.6.2'), cached 6h.
    '' if unreachable."""
    now = time.time()
    if _latest_ver_cache["ver"] and (now - _latest_ver_cache["ts"]) < 6 * 3600:
        return _latest_ver_cache["ver"]
    try:
        import requests
        r = requests.get("https://api.github.com/repos/ollama/ollama/releases/latest",
                         timeout=5, headers={"User-Agent": "Cortex-Cookbook"})
        tag = (r.json().get("tag_name", "") or "").lstrip("vV")
        if tag:
            _latest_ver_cache.update(ts=now, ver=tag)
        return tag
    except Exception:
        return ""


def _ver_tuple(v):
    """'0.20.0' -> (0,20,0); non-numeric parts → 0. Empty → ()."""
    parts = []
    for p in (v or "").split("."):
        m = re.match(r"\d+", p)
        parts.append(int(m.group(0)) if m else 0)
    return tuple(parts)


def is_ollama_outdated():
    """(outdated_bool, installed, latest). Outdated only when both versions are
    known and installed < latest."""
    installed = get_ollama_version()
    latest = get_latest_ollama_version()
    if not installed or not latest:
        return False, installed, latest
    return _ver_tuple(installed) < _ver_tuple(latest), installed, latest


def is_ollama_installed():
    """True if the Ollama binary is present OR the server answers. Lets the UI
    offer an in-app 'Install Ollama' button when it's missing (zero-terminal)."""
    try:
        import shutil
        if shutil.which("ollama"):
            return True
    except Exception:
        pass
    try:
        import requests
        requests.get("http://localhost:11434/api/version", timeout=2)
        return True
    except Exception:
        return False


def _installed_models():
    """Return the set of model tags already pulled locally (from Ollama
    /api/tags), e.g. {'llama3.2:3b', 'gemma3:12b'}. Empty set on failure."""
    try:
        import requests
        r = requests.get("http://localhost:11434/api/tags", timeout=3)
        return {m.get("name", "") for m in r.json().get("models", [])}
    except Exception:
        return set()


def _available_gb(hw):
    """Usable memory budget for a model. Dedicated GPU → VRAM; Apple/CPU → a
    conservative slice of system RAM (the OS + app need the rest)."""
    if hw.get("vram_gb", 0) >= 1:
        return hw["vram_gb"]
    return round(hw.get("ram_gb", 0) * 0.6, 1)


# ---------------------------------------------------------------------------
# Live catalog — scraped from ollama.com/library (trending/newest first), with
# the curated CATALOG above as an offline fallback.
# ---------------------------------------------------------------------------
_LIVE_TTL = 6 * 3600  # re-scrape at most every 6 hours
_live_cache = {"ts": 0.0, "data": None}

# Families that aren't general chat/serving models (embedding, vision-only enc).
_SKIP_FAMILIES = {"nomic-embed-text", "mxbai-embed-large", "bge-m3", "all-minilm",
                  "snowflake-arctic-embed", "paraphrase-multilingual"}


def _params_to_b(tok):
    """'8b'->8.0, '270m'->0.27, '1.5b'->1.5. Returns None if not a size token."""
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([bm])", tok.lower())
    if not m:
        return None
    val = float(m.group(1))
    return val / 1000.0 if m.group(2) == "m" else val


def fetch_live_catalog(limit_families=22, sizes_per_family=3):
    """Scrape ollama.com/library for current models. Returns a catalog list
    (same shape as CATALOG) or None on any failure. Cached for _LIVE_TTL."""
    now = time.time()
    if _live_cache["data"] is not None and (now - _live_cache["ts"]) < _LIVE_TTL:
        return _live_cache["data"]
    try:
        import requests
        from bs4 import BeautifulSoup
        resp = requests.get("https://ollama.com/library", timeout=8,
                            headers={"User-Agent": "Mozilla/5.0 (Cortex Cookbook)"})
        if resp.status_code != 200:
            return None
        soup = BeautifulSoup(resp.text, "html.parser")
        catalog, seen = [], set()
        for a in soup.select('a[href^="/library/"]'):
            family = a.get("href", "").split("/library/")[-1].strip("/")
            if not family or family in seen or family in _SKIP_FAMILIES:
                continue
            text = " ".join(a.get_text(" ", strip=True).split())
            # Strip the card metadata ("74.3M Pulls", "29 Tags", "Updated … ago")
            # FIRST so pull-counts aren't mis-parsed as model sizes.
            clean = re.sub(r"\d[\d.]*[KMB]?\s+Pulls", " ", text, flags=re.I)
            clean = re.sub(r"\d+\s+Tags", " ", clean, flags=re.I)
            clean = re.sub(r"Updated.*$", " ", clean, flags=re.I)
            low = clean.lower()
            if "embedding" in low:  # skip embedding models
                continue
            # description = text after the family name, up to the first marker
            desc = clean[len(family):].strip()
            desc = re.split(r"\b(tools|vision|cloud|thinking|\d+(?:\.\d+)?[bm])\b",
                            desc, maxsplit=1)[0].strip(" .—-")
            is_vision = "vision" in low
            # collect size tokens (1b, 4b, 27b, 70b, 405b, 270m …) from the
            # metadata-stripped text only.
            sizes = []
            for tok in re.findall(r"\b\d+(?:\.\d+)?[bm]\b", low):
                p = _params_to_b(tok)
                if p and tok not in [s[0] for s in sizes]:
                    sizes.append((tok, p))
            if not sizes:
                continue
            seen.add(family)
            # keep the largest few distinct sizes (most interesting), sorted asc
            sizes = sorted(sizes, key=lambda s: s[1])[:sizes_per_family]
            for tok, params in sizes:
                gb = round(params * 0.6, 1)  # ≈ Q4 footprint
                note = (desc[:90] or family) + (" · 👁 vision" if is_vision else "")
                catalog.append({"model": f"{family}:{tok}", "params": tok.upper(),
                                "gb": gb, "note": note})
            if len(seen) >= limit_families:
                break
        if not catalog:
            return None
        _live_cache["ts"] = now
        _live_cache["data"] = catalog
        return catalog
    except Exception as e:
        print(f"🍳 [Cookbook] live catalog fetch failed: {e}")
        return None


# Curated MLX models (Apple Silicon). Served via the local-mlx: provider in
# ai_client.py (downloaded from HuggingFace on first load), NOT `ollama pull`.
MLX_CATALOG = [
    {"model": "Llama-3.2-3B-Instruct-4bit", "params": "3B", "gb": 2.0,
     "note": "Apple MLX (needs mlx-lm) · fast 4-bit Llama 3.2", "mlx_repo": "mlx-community/Llama-3.2-3B-Instruct-4bit"},
    {"model": "Qwen2.5-7B-Instruct-4bit", "params": "7B", "gb": 4.3,
     "note": "Apple MLX · strong general 7B", "mlx_repo": "mlx-community/Qwen2.5-7B-Instruct-4bit"},
    {"model": "Mistral-7B-Instruct-v0.3-4bit", "params": "7B", "gb": 4.1,
     "note": "Apple MLX · reliable 7B", "mlx_repo": "mlx-community/Mistral-7B-Instruct-v0.3-4bit"},
    {"model": "Meta-Llama-3.1-8B-Instruct-4bit", "params": "8B", "gb": 4.6,
     "note": "Apple MLX · popular 8B", "mlx_repo": "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit"},
    {"model": "gemma-2-9b-it-4bit", "params": "9B", "gb": 5.2,
     "note": "Apple MLX · Google Gemma 2", "mlx_repo": "mlx-community/gemma-2-9b-it-4bit"},
    {"model": "Qwen2.5-14B-Instruct-4bit", "params": "14B", "gb": 8.4,
     "note": "Apple MLX · stronger reasoning 14B", "mlx_repo": "mlx-community/Qwen2.5-14B-Instruct-4bit"},
]


def _family_base_version(family: str):
    """Split an Ollama library family into (base, version_float).
    'qwen3'->('qwen',3.0), 'qwen2.5'->('qwen',2.5), 'llama3.3'->('llama',3.3),
    'mistral'->('mistral',0.0). Lets us keep only the latest version per base."""
    m = re.search(r'(\d+(?:\.\d+)?)$', family)
    if not m:
        return family, 0.0
    base = family[:m.start()].rstrip('-.')
    try:
        return (base or family), float(m.group(1))
    except ValueError:
        return family, 0.0


def _collapse_to_best_per_family(rows):
    """Keep exactly ONE entry per model family — the best fit for this hardware:
    the LARGEST size that still fits (green/yellow), else the smallest option.
    `rows` are already scored (have band/fit_score). Preserves input order by
    best pick. MLX entries are treated as their own families so they still show."""
    by_family = {}
    for r in rows:
        model = r.get("model", "")
        # Family = base name without the size tag. MLX repos keep their full id.
        fam = model.split(":")[0] if ":" in model else model
        if r.get("serving") == "mlx":
            fam = "mlx:" + fam
        by_family.setdefault(fam, []).append(r)

    chosen = []
    for fam, items in by_family.items():
        fits = [x for x in items if x.get("band") in ("green", "yellow")]
        pool = fits if fits else items
        # Largest that fits (more capable) → by gb desc; if none fit, smallest gb.
        if fits:
            pick = max(pool, key=lambda x: x.get("gb", 0))
        else:
            pick = min(pool, key=lambda x: x.get("gb", 0) or 1e9)
        chosen.append(pick)
    chosen.sort(key=lambda r: r.get("fit_score", 0), reverse=True)
    return chosen


def _dedupe_to_latest(catalog):
    """Keep only the newest version family per base name (e.g. drop qwen2/qwen2.5
    when qwen3 exists; gemma2 when gemma3 exists) so non-technical users see one
    obvious choice per model line."""
    best_ver = {}
    for entry in catalog:
        family = entry["model"].split(":")[0]
        base, ver = _family_base_version(family)
        if base not in best_ver or ver > best_ver[base][0]:
            best_ver[base] = (ver, family)
    keep_families = {fam for _, fam in best_ver.values()}
    return [e for e in catalog if e["model"].split(":")[0] in keep_families]


def _score_catalog(catalog, avail):
    rows = []
    for entry in catalog:
        need = entry.get("gb", 0) or 0
        if avail <= 0 or need <= 0:
            score, band = 0, "red"
        else:
            ratio = need / avail
            if ratio <= 0.6:
                band = "green"; score = int(max(60, 100 - ratio * 40))
            elif ratio <= 0.9:
                band = "yellow"; score = int(70 - (ratio - 0.6) * 100)
            else:
                band = "red"; score = max(0, int(40 - (ratio - 0.9) * 40))
        # Models that won't fit (red) route to AirLLM Deep Think, not a pull.
        serving = "deepthink" if band == "red" else "ollama"
        rows.append({**entry, "fit_score": score, "band": band, "serving": serving})
    rows.sort(key=lambda r: r["fit_score"], reverse=True)
    return rows


def recommend(hw=None):
    """Score models against the hardware (best-fit first). Uses the LIVE
    ollama.com/library catalog, deduped to the latest version per family
    (gemma4, latest qwen/llama/deepseek…), falling back to the curated CATALOG
    offline. Fitting models serve via `ollama pull`; oversized ones route to
    Deep Think. Adds MLX models on Apple Silicon. Already-installed models are
    flagged. If the newest models need a newer Ollama, `ollama_outdated` lets the
    UI offer an in-app update."""
    hw = hw or scan_hardware()
    avail = _available_gb(hw)
    installed = _installed_models()

    live = fetch_live_catalog()
    catalog = _dedupe_to_latest(live if live else CATALOG)
    rows = _score_catalog(catalog, avail)

    # Apple Silicon: also surface MLX models (served via local-mlx:, not pull).
    if hw.get("mps"):
        mlx_rows = _score_catalog(MLX_CATALOG, avail)
        for r in mlx_rows:
            r["serving"] = "mlx"  # frontend → "Serve with MLX"
        rows = rows + mlx_rows

    # Exactly ONE model per family — the latest version at the best size for the
    # user's hardware (no more multiple sizes of the same model).
    rows = _collapse_to_best_per_family(rows)

    for r in rows:
        r["installed"] = r.get("model") in installed

    outdated, installed_ver, latest_ver = is_ollama_outdated()
    return {"hardware": hw, "available_gb": avail,
            "source": "live" if live else "curated", "models": rows,
            "ollama_version": installed_ver,
            "ollama_latest": latest_ver,
            "ollama_outdated": outdated,
            "ollama_installed": is_ollama_installed()}

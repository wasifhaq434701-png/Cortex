import os
import re
import traceback
import requests
import httpx
from litellm import completion

# Global cache to keep MLX models in unified memory between requests
MLX_MODEL_CACHE = {}


def _apply_cloud_key(provider: str, api_key: str):
    """Set the provider's API key in the environment as a secondary fallback.

    The primary, universal path is passing ``api_key=`` directly to
    ``litellm.completion()`` — but some providers also read env vars, so we
    mirror the key there too. Gemini is checked under two different names by
    litellm, so set both.
    """
    if not api_key:
        return
    prefix = provider.split('/')[0].upper()
    os.environ[f"{prefix}_API_KEY"] = api_key
    if prefix in ("GEMINI", "GOOGLE"):
        os.environ["GEMINI_API_KEY"] = api_key
        os.environ["GOOGLE_API_KEY"] = api_key


_DEFAULT_CLOUD_MODEL = {
    "anthropic": "claude-3-5-sonnet-latest",
    "groq": "groq/llama-3.3-70b-versatile",
    "xai": "xai/grok-2-latest",
    "gemini": "gemini/gemini-3-flash-preview",
    "openai": "gpt-4o",
}


def _detect_key_family(api_key: str):
    """Identify the cloud provider from the API key's prefix. Most-specific
    prefixes are checked first (sk-ant- before sk-). Returns None for unknown
    keys so we never mis-route a custom/third-party key."""
    k = (api_key or "").strip()
    if k.startswith("sk-ant-"):
        return "anthropic"
    if k.startswith("gsk_"):
        return "groq"
    if k.startswith("xai-"):
        return "xai"
    if k.startswith("AIza"):
        return "gemini"
    if k.startswith("sk-"):  # sk-, sk-proj-, ...
        return "openai"
    return None


def _model_family(provider: str):
    """Classify a litellm model string into a provider family, or None if it's
    a custom/unknown model we should leave untouched."""
    p = (provider or "").lower()
    if p.startswith("gemini/") or p.startswith("google"):
        return "gemini"
    if p.startswith("groq/"):
        return "groq"
    if p.startswith("xai/") or p.startswith("grok"):
        return "xai"
    if p.startswith("anthropic/") or p.startswith("claude"):
        return "anthropic"
    if p.startswith("openai/") or p.startswith("gpt") or p.startswith("o1") or p.startswith("o3"):
        return "openai"
    return None


def _route_for_key(provider: str, api_key: str) -> str:
    """Universal routing: pick the model that matches the pasted key, correcting
    a wrong dropdown selection (e.g. a Groq key while 'xAI Grok' is selected).
    Only overrides a clear mismatch between a KNOWN provider model and a KNOWN
    key family — custom models and unknown keys are respected as-is."""
    kfam = _detect_key_family(api_key)
    if not kfam:
        return provider                      # unknown key → trust the user's model
    mfam = _model_family(provider)
    if mfam is None:
        return provider                      # custom/unknown model → respect it
    if mfam == kfam:
        return provider                      # already correct → keep exact model
    return _DEFAULT_CLOUD_MODEL.get(kfam, provider)  # mismatch → route to the key's provider


def _friendly_cloud_error(provider: str, exc: Exception) -> str:
    """Turn a raw litellm/provider exception into a short, actionable one-line
    message for the chat — instead of dumping a giant JSON traceback. Detection
    is by status code + message substring so it survives litellm wrappers
    (e.g. MidStreamFallbackError) that hide the inner exception class."""
    msg = str(exc) or ""
    low = msg.lower()
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)

    # Rate limit / quota — check first (the 429 body also mentions billing/plan).
    if status == 429 or any(s in low for s in ("resource_exhausted", "ratelimit", "rate limit", "quota", " 429", "code: 429", "code\": 429")):
        return (f"⚠️ {provider}: rate limit or quota exceeded — your API key has no remaining "
                f"free-tier quota for this model right now. Wait a minute and retry, switch to a "
                f"model your key supports (e.g. gemini/gemini-3-flash-preview), or enable billing in the provider console.")
    # Authentication / permission.
    if status in (401, 403) or any(s in low for s in ("authenticat", "permission denied", "invalid api key", "api key not valid", "unauthorized")):
        return f"⚠️ {provider}: authentication failed — check that your API key is correct and active."
    # Model not found / unavailable.
    if status == 404 or "not found" in low or "notfound" in low or "does not exist" in low:
        return f"⚠️ {provider}: that model isn't available to your key. Pick a different model."
    # Fallback — first line only, never the full JSON wall.
    short = msg.strip().split("\n")[0][:300]
    return f"⚠️ {provider} error: {short}"

def calculate_dynamic_timeout(model_name: str) -> int:
    """Extracts parameter size from model name to allocate optimal loading time."""
    timeout = 120  # Fallback default
    
    # Matches numbers including decimals right next to 'b' or 'B' (e.g., 27b, 1.5b)
    match = re.search(r'(\d+(?:\.\d+)?)[bB]', model_name)
    
    if match:
        try:
            size = float(match.group(1))
            
            if size <= 15:
                timeout = 600       # Light models (7b, 8b) get 10 mins
            elif 16 <= size <= 35:
                timeout = 1800      # Mid-weight models (27b, 32b) get 30 mins
            elif size > 35:
                timeout = 3600      # Heavy models (70b+) get 60 mins
        except ValueError:
            pass
            
    return timeout

import json

# Lean base persona — always sent. Keeps prompt-eval cheap on big local models.
_BASE_SYSTEM_PROMPT = """You are 'Cortex', an advanced local data analytics agent.
The context section below contains content from the user's files — their mapped project/codebase, uploaded PDFs/documents/spreadsheets/code, and OCR'd images.

HOW TO USE THE CONTEXT:
- When the user asks about "the project", "the mapped project", "my codebase", "my files", "this repo", or anything about their own data, the context below IS that project/data — use it directly and answer from it. Do NOT say you have no information when project files are present.
- When the user clearly asks for something unrelated to their files (e.g. "write a generic Python snippet" or "make a presentation about <general topic>"), you may ignore the context and answer from your own knowledge. Don't pad answers with unrelated file content.
- Content marked [FULL CONTENT FROM UPLOADED FILE:] is a file the user just gave you — use it fully."""

# Heavy chart/diagram protocols — only appended when the query actually needs
# them (otherwise they inflate prompt-eval time every turn for nothing).
_VIZ_PROTOCOLS = """

VISUALIZATION PROTOCOL:
If the user asks to visualize, chart, or plot data from ANY file type (Excel, CSV, SQL), you must use the data provided in the context to build an accurate chart.
Do NOT write python code to plot. Instead, output your text explanation followed by this exact JSON format enclosed ONLY in <CHART> tags:

<CHART>
{
  "type": "bar",
  "label": "Chart Title Here",
  "labels": ["Category A", "Category B", "Category C"],
  "data": [15.5, 42.1, 8.9]
}
</CHART>

Supported types: 'bar', 'line', 'pie', 'doughnut', 'radar'. Adapt the layout type to best fit the data relationships.

DIAGRAMMING PROTOCOL:
If the user asks for an architecture diagram, flowchart, system diagram, class diagram, sequence diagram, or any structural visualization, output valid Mermaid.js syntax enclosed in <MERMAID> tags:

<MERMAID>
graph TD
    A[Start] --> B[Process]
    B --> C{Decision}
    C -->|Yes| D[Result A]
    C -->|No| E[Result B]
</MERMAID>

Supported Mermaid diagram types: graph/flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, pie, mindmap.
Use Mermaid whenever the user asks about relationships, flows, dependencies, or architecture.

CONTENT GENERATION:
When asked to create reports, presentations, or documents on any topic, provide comprehensive, well-structured content."""

_VIZ_KEYWORDS = ("chart", "plot", "graph", "visuali", "diagram", "flowchart",
                 "architecture", "sequence", "mermaid", "bar ", "pie ", "trend",
                 "presentation", "report", "slide")


async def run_contextual_chat(question: str, context: str, provider: str = "local", api_key: str = "", system_prompt: str = None, images: list = None):
    """Universal router supporting dynamic local model timeouts and cloud providers via LiteLLM (Streaming)."""
    try:
        if not system_prompt:
            # Only attach the heavy viz/diagram protocols when the query looks
            # like it needs them; plain chat ships the lean base prompt.
            q_low = (question or "").lower()
            if any(k in q_low for k in _VIZ_KEYWORDS):
                system_prompt = _BASE_SYSTEM_PROMPT + _VIZ_PROTOCOLS
            else:
                system_prompt = _BASE_SYSTEM_PROMPT

        # Safety net: never let an oversized context blow up prompt-eval time.
        # (A mapped project was injecting ~59K tokens of file content into every
        # turn.) Keep the most recent ~8000 chars; sources cap upstream too.
        if context and len(context) > 8000:
            context = context[-8000:]

        combined_prompt = f"{system_prompt}\n\nContext:\n{context}\n\nUser Query: {question}\nAnswer:"

        # ---------------------------------------------------------
        # LOCAL MLX ROUTING (Apple Silicon)
        # ---------------------------------------------------------
        if provider.startswith("local-mlx:"):
            repo_id = provider[10:]
            try:
                import mlx_lm
                global MLX_MODEL_CACHE
                if repo_id not in MLX_MODEL_CACHE:
                    print(f"Loading MLX model: {repo_id} into unified memory...")
                    model, tokenizer = mlx_lm.load(repo_id)
                    MLX_MODEL_CACHE[repo_id] = (model, tokenizer)
                else:
                    model, tokenizer = MLX_MODEL_CACHE[repo_id]
                
                # Try streaming if supported, else fallback to full generation
                if hasattr(mlx_lm, "stream_generate"):
                    for chunk in mlx_lm.stream_generate(model, tokenizer, prompt=combined_prompt, max_tokens=4096):
                        yield chunk
                else:
                    response = mlx_lm.generate(model, tokenizer, prompt=combined_prompt, max_tokens=4096, verbose=True)
                    yield response.strip()
            except ImportError:
                yield "System Alert: mlx_lm is not installed. MLX routing is only available on Apple Silicon with mlx-lm."
            except Exception as e:
                yield f"MLX Inference Error: {str(e)}"

        # ---------------------------------------------------------
        # LOCAL OLLAMA ROUTING
        # ---------------------------------------------------------
        elif provider.startswith("local"):
            model_name = provider[6:] if provider.startswith("local:") else "llama3.2"
            allocated_timeout = calculate_dynamic_timeout(model_name)
            
            url = "http://127.0.0.1:11434/api/generate"
            payload = {
                "model": model_name,
                "prompt": f"Context:\n{context}\n\nUser Query: {question}\nAnswer:",
                "system": system_prompt,
                "stream": True,
                # Keep the model resident for 30 min between turns. Without this
                # Ollama unloads it after ~5 min idle, so the next chat pays a full
                # cold reload (very slow for a 27B) — which is exactly why the main
                # chat felt slow while `ollama run` in a terminal stays fast.
                "keep_alive": "30m",
                # Bound the context WINDOW so a big prompt can't blow up prompt-eval
                # time (a mapped project was injecting ~59K tokens → minutes per
                # turn). This caps INPUT context only; do NOT add num_predict — an
                # output cap truncates long PPT/code generations mid-stream.
                "options": {"num_ctx": 8192}
            }
            # Vision: pass base64 image(s) to a multimodal model (e.g. gemma3,
            # llava, llama3.2-vision). Ollama accepts them on /api/generate.
            if images:
                payload["images"] = images
            
            try:
                async with httpx.AsyncClient() as client:
                    async with client.stream("POST", url, json=payload, timeout=allocated_timeout) as r:
                        if r.status_code == 404:
                            yield f"System Alert: Ollama returned 404. The model '{model_name}' is not recognized. Try running `ollama pull {model_name}` in your terminal."
                            return
                        elif r.status_code != 200:
                            yield f"System Alert: Ollama returned unexpected status code {r.status_code}."
                            return
                            
                        async for line in r.aiter_lines():
                            if line:
                                data = json.loads(line)
                                if "response" in data:
                                    yield data["response"]
                                    
            except httpx.ReadTimeout:
                yield f"System Alert: The model '{model_name}' timed out after {allocated_timeout} seconds while allocating memory."
            except httpx.RequestError:
                yield "System Alert: Connection refused. Is your local Ollama app fully running?"

        # ---------------------------------------------------------
        # UNIVERSAL CLOUD ROUTING (LiteLLM)
        # ---------------------------------------------------------
        else:
            try:
                if not (api_key or "").strip():
                    yield "Cloud API Integration Error: No API key provided for cloud provider. Paste your key in the API Key box."
                    return
                provider = _route_for_key(provider, api_key)
                _apply_cloud_key(provider, api_key)

                response = completion(
                    model=provider,
                    messages=[{"role": "user", "content": combined_prompt}],
                    api_key=api_key,
                    stream=True
                )
                for chunk in response:
                    if chunk.choices[0].delta.content:
                        yield chunk.choices[0].delta.content
            except Exception as cloud_err:
                yield _friendly_cloud_error(provider, cloud_err)

    except Exception as global_err:
        error_trace = traceback.format_exc()
        yield f"Internal Server Exception Caught:\n{str(global_err)}\n\nDetails:\n{error_trace}"

def generate_cluster_titles(nodes_summary: str, provider: str = "local", api_key: str = "") -> str:
    """Generates concise titles for data semantic clusters or file content summaries."""
    try:
        prompt = (
            "You are an expert data analyst. Review the provided data layout summary "
            "and return a highly concise, professional descriptive title (maximum 3-5 words).\n\n"
            f"Data Summary:\n{nodes_summary}\n\nTitle:"
        )

        if provider.startswith("local-mlx:"):
            repo_id = provider[10:]
            try:
                import mlx_lm
                global MLX_MODEL_CACHE
                if repo_id not in MLX_MODEL_CACHE:
                    model, tokenizer = mlx_lm.load(repo_id)
                    MLX_MODEL_CACHE[repo_id] = (model, tokenizer)
                else:
                    model, tokenizer = MLX_MODEL_CACHE[repo_id]
                    
                response = mlx_lm.generate(model, tokenizer, prompt=prompt, max_tokens=15, verbose=False)
                return response.strip().strip('"')
            except:
                return "Data Concept Cluster"

        elif provider.startswith("local"):
            model_name = provider[6:] if provider.startswith("local:") else "llama3.2"
            allocated_timeout = calculate_dynamic_timeout(model_name)
            
            url = "http://127.0.0.1:11434/api/generate"
            payload = {"model": model_name, "prompt": prompt, "stream": False, "keep_alive": "30m"}

            response = requests.post(url, json=payload, timeout=allocated_timeout)
            if response.status_code == 200:
                return response.json().get("response", "").strip().strip('"')
            return "Data Concept Cluster"
            
        else:
            provider = _route_for_key(provider, api_key)
            _apply_cloud_key(provider, api_key)

            response = completion(
                model=provider,
                messages=[{"role": "user", "content": prompt}],
                api_key=api_key
            )
            return response.choices[0].message.content.strip().strip('"')

    except Exception:
        return "Analyzed Data Node"

def _heuristic_cluster_title(files: list) -> str:
    """Instant, no-LLM title for a cluster from its filenames — used as a fast
    fallback so mapping never hangs waiting on a slow model."""
    import os as _os
    from collections import Counter
    exts, stems = Counter(), Counter()
    for f in files[:20]:
        base = _os.path.basename(str(f))
        ext = _os.path.splitext(base)[1].lstrip(".").lower()
        if ext:
            exts[ext] += 1
        for tok in re.split(r"[^a-zA-Z]+", _os.path.splitext(base)[0]):
            if len(tok) >= 4:
                stems[tok.lower()] += 1
    top_stem = stems.most_common(1)[0][0].title() if stems else ""
    top_ext = exts.most_common(1)[0][0].upper() if exts else "Files"
    return (f"{top_stem} {top_ext}".strip()) or "Data Cluster"


def generate_cluster_titles_batch(clusters: dict, provider: str = "local", api_key: str = "",
                                  timeout: int = 90) -> dict:
    """Generate titles for ALL clusters in ONE LLM call (fast: a single model
    load + one generation, vs one call per cluster). `clusters` = {cid: [files]}.
    Returns {str(cid): title}. Falls back to instant heuristic titles on timeout
    or parse failure so mapping NEVER hangs."""
    fallback = {str(cid): _heuristic_cluster_title(files) for cid, files in clusters.items()}
    if not clusters:
        return {}
    try:
        lines = []
        for cid, files in clusters.items():
            uniq = list(dict.fromkeys(str(f).split("/")[-1] for f in files))[:6]
            lines.append(f'{cid}: {", ".join(uniq)}')
        listing = "\n".join(lines)
        prompt = (
            "You are an expert data analyst. For EACH numbered cluster below, give a "
            "concise 2-4 word descriptive title based on its filenames. Respond with "
            "ONLY a JSON object mapping each cluster id (as a string) to its title, "
            "e.g. {\"0\":\"User Authentication\",\"1\":\"Data Models\"}.\n\n"
            f"Clusters:\n{listing}\n\nJSON:"
        )

        text = ""
        if provider.startswith("local") and not provider.startswith("local-mlx:"):
            model_name = provider[6:] if provider.startswith("local:") else "llama3.2"
            r = requests.post("http://127.0.0.1:11434/api/generate",
                              json={"model": model_name, "prompt": prompt, "stream": False,
                                    "keep_alive": "30m", "options": {"num_ctx": 4096}},
                              timeout=timeout)
            if r.status_code == 200:
                text = r.json().get("response", "")
        else:
            # MLX / cloud: reuse the single-title path per cluster is too slow; just
            # use the cloud completion once.
            provider = _route_for_key(provider, api_key)
            _apply_cloud_key(provider, api_key)
            resp = completion(model=provider, messages=[{"role": "user", "content": prompt}], api_key=api_key)
            text = resp.choices[0].message.content

        m = re.search(r"\{.*\}", text or "", re.DOTALL)
        if m:
            parsed = json.loads(m.group(0))
            out = {}
            for cid in clusters:
                t = parsed.get(str(cid)) or parsed.get(cid)
                out[str(cid)] = (str(t).strip().strip('"')[:40] if t else fallback[str(cid)])
            return out
    except Exception as e:
        print(f"[cluster-titles] batch failed, using heuristics: {e}")
    return fallback


def generate_hyde_document(query: str, provider: str = "local", api_key: str = "") -> str:
    """Generates a Hypothetical Document Embedding (HyDE) for Advanced RAG."""
    prompt = (
        "Please write a passage that directly answers the following query. "
        "Write as if you are the source text providing the factual information.\n\n"
        f"Query: {query}\n\nPassage:"
    )

    try:
        if provider.startswith("local-mlx:"):
            repo_id = provider[10:]
            import mlx_lm
            global MLX_MODEL_CACHE
            if repo_id not in MLX_MODEL_CACHE:
                model, tokenizer = mlx_lm.load(repo_id)
                MLX_MODEL_CACHE[repo_id] = (model, tokenizer)
            else:
                model, tokenizer = MLX_MODEL_CACHE[repo_id]
                
            response = mlx_lm.generate(model, tokenizer, prompt=prompt, max_tokens=256, verbose=False)
            return response.strip()

        elif provider.startswith("local"):
            # For local models, generating HyDE synchronously blocks the UI and is very slow.
            # Return query to skip HyDE and use direct semantic search.
            return query
            
        else:
            provider = _route_for_key(provider, api_key)
            _apply_cloud_key(provider, api_key)

            response = completion(
                model=provider,
                messages=[{"role": "user", "content": prompt}],
                api_key=api_key
            )
            return response.choices[0].message.content.strip()

    except Exception as e:
        print(f"HyDE generation failed: {e}")
        return query
"""Phase 7 — Deep Research Agent (blocking pipeline).

search (DuckDuckGo) -> crawl + extract readable text (requests + BeautifulSoup)
-> analyze (scikit-learn TF-IDF + KMeans topic modelling) -> return a structured
brief. The async SSE orchestration + LLM synthesis lives in main.py; this module
is pure, importable, and degrades gracefully when optional deps are missing.
"""
import re
import concurrent.futures

MAX_LINKS_DEFAULT = 5
PER_PAGE_CHARS = 6000


def search_links(query: str, max_results: int = 8):
    """Return [{title, href, body}] from DuckDuckGo.

    The `duckduckgo_search` package was renamed to `ddgs` and the old one now
    returns nothing — so we use `ddgs` first and fall back to the legacy import.
    Normalizes result keys (`url`/`link` → `href`) across versions.
    """
    def _norm(rows):
        out = []
        for r in (rows or []):
            href = r.get("href") or r.get("url") or r.get("link") or ""
            if href:
                out.append({"title": r.get("title", ""), "href": href, "body": r.get("body", "") or r.get("snippet", "")})
        return out

    # Preferred: the current `ddgs` package
    try:
        from ddgs import DDGS
        with DDGS() as d:
            rows = list(d.text(query, max_results=max_results))
        res = _norm(rows)
        if res:
            return res
    except Exception as e:
        print(f"[research] ddgs search failed: {e}")

    # Fallback: legacy duckduckgo_search (may be deprecated/empty)
    try:
        from duckduckgo_search import DDGS as LegacyDDGS
        with LegacyDDGS() as d:
            rows = list(d.text(query, max_results=max_results))
        res = _norm(rows)
        if res:
            return res
    except Exception as e:
        print(f"[research] legacy duckduckgo_search failed: {e}")

    print("[research] no search results from any backend for:", query)
    return []


def _extract_readable(html: str) -> str:
    """Best-effort main-content extraction. Tries readability, falls back to bs4."""
    try:
        from readability import Document
        doc = Document(html)
        html = doc.summary(html_partial=True)
    except Exception:
        pass
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "noscript", "header", "footer", "nav", "aside"]):
            tag.decompose()
        text = soup.get_text(separator="\n")
    except Exception:
        # crude tag strip
        text = re.sub(r"<[^>]+>", " ", html)
    lines = [ln.strip() for ln in text.splitlines() if len(ln.strip()) > 40]
    return "\n".join(lines)[:PER_PAGE_CHARS]


def fetch_page(url: str) -> str:
    try:
        import requests
        r = requests.get(url, timeout=8, headers={
            "User-Agent": "Mozilla/5.0 (CortexResearch/1.0)"
        })
        if r.status_code == 200 and "text/html" in r.headers.get("content-type", ""):
            return _extract_readable(r.text)
    except Exception as e:
        print(f"[research] fetch failed {url}: {e}")
    return ""


def crawl(urls, max_links: int = MAX_LINKS_DEFAULT):
    """Fetch the top links in parallel; returns [(url, text), ...] for non-empty pages."""
    urls = urls[:max_links]
    out = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(urls) or 1, 5)) as ex:
        for url, text in zip(urls, ex.map(fetch_page, urls)):
            if text:
                out.append((url, text))
    return out


def analyze(docs):
    """TF-IDF + KMeans topic modelling over the crawled documents.
    Returns {topics: [{terms, size}], top_terms: [...]}. Degrades if sklearn/too few docs."""
    texts = [t for _, t in docs]
    if len(texts) < 2:
        return {"topics": [], "top_terms": []}
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.cluster import KMeans
        vec = TfidfVectorizer(max_features=400, stop_words="english", ngram_range=(1, 2))
        X = vec.fit_transform(texts)
        terms = vec.get_feature_names_out()
        # global top terms
        import numpy as np
        scores = X.sum(axis=0).A1
        top_idx = scores.argsort()[::-1][:15]
        top_terms = [terms[i] for i in top_idx]
        # cluster into k topics
        k = max(2, min(4, len(texts)))
        km = KMeans(n_clusters=k, n_init=5, random_state=42).fit(X)
        topics = []
        centers = km.cluster_centers_
        for c in range(k):
            tildx = centers[c].argsort()[::-1][:6]
            topics.append({
                "terms": [terms[i] for i in tildx],
                "size": int((km.labels_ == c).sum()),
            })
        return {"topics": topics, "top_terms": top_terms}
    except Exception as e:
        print(f"[research] analyze failed: {e}")
        return {"topics": [], "top_terms": []}


def gather(query: str, max_links: int = MAX_LINKS_DEFAULT):
    """Full blocking pipeline: search -> crawl -> analyze. Returns a brief dict
    used to build the LLM synthesis prompt. Breadth + corpus scale with
    max_links (the depth slider: 5 = standard, 8 = thorough)."""
    max_links = max(3, int(max_links or MAX_LINKS_DEFAULT))
    # Search wider than we crawl so failed fetches still leave enough sources.
    results = search_links(query, max_results=max(8, max_links * 2))
    urls = [r.get("href") for r in results if r.get("href")]
    crawled = crawl(urls, max_links)
    analysis = analyze(crawled)
    sources = [{"title": r.get("title", ""), "href": r.get("href", "")} for r in results[:max_links]]
    # Corpus budget grows with depth so thorough reports have more to work with.
    per_page = 3000 if max_links >= 8 else 2500
    corpus_cap = 24000 if max_links >= 8 else 14000
    corpus = "\n\n".join(f"SOURCE: {u}\n{t[:per_page]}" for u, t in crawled)
    return {
        "query": query,
        "sources": sources,
        "analysis": analysis,
        "corpus": corpus[:corpus_cap],
        "pages_read": len(crawled),
    }


def build_synthesis_prompt(brief: dict) -> str:
    a = brief.get("analysis", {})
    topics = "; ".join(", ".join(t["terms"]) for t in a.get("topics", [])) or "n/a"
    top_terms = ", ".join(a.get("top_terms", [])) or "n/a"
    srcs = "\n".join(f"- [{s['title']}]({s['href']})" for s in brief.get("sources", []))
    return (
        f"Research query: {brief['query']}\n"
        f"Pages analyzed: {brief.get('pages_read', 0)}\n"
        f"Key terms (TF-IDF): {top_terms}\n"
        f"Discovered topic clusters: {topics}\n\n"
        f"Extracted source material:\n{brief.get('corpus', '')}\n\n"
        f"Sources:\n{srcs}\n"
    )

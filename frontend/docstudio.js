// ==========================================================================
// Cortex IDE — Documents Editor + Deep Research surfaces (Phase 7+).
// Standalone, full-screen writing app built on the shared window.DocEngine:
//   - intent prompt ("what are you writing?") → LLM context + optional draft
//   - Grammarly-style inline grammar/style underlines (click-to-fix)
//   - ghost-text sentence completion (Tab to accept)
//   - open / save / export (client + server)
//   - Deep Research query screen → streams a synthesized report into a doc
// Degrades gracefully when the Quill/marked CDNs or the LLM are unavailable.
// ==========================================================================

(function () {
    'use strict';

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    let q = null;                 // the Documents-Editor Quill instance
    let docCtx = { intent: '', topic: '' };
    let curDoc = { path: null, name: 'Untitled.md', ext: 'md', dirty: false };
    let suggestOn = true;
    let suppress = false;         // ignore programmatic edits
    let activeStream = null;

    const E = () => window.DocEngine;

    // ---- lazy init --------------------------------------------------------
    window.initDocumentStudio = function (opts) {
        opts = opts || {};
        if (q) { setTimeout(() => { try { q.focus(); } catch (e) {} }, 30); return; }
        if (!E() || typeof Quill === 'undefined') {
            showToast('Rich-text editor unavailable (offline?).', 'error');
            return;
        }
        registerSuggestFormat();
        q = E().makeQuill('#docstudio-editor', {
            placeholder: 'Start writing — or click “🎯 Context” to set up context and a draft…',
            bindings: ghostKeyBindings(),
            onTextChange: onDocChange
        });
        buildTopbar();
        wireGhostText();
        q.on('selection-change', () => { hideGhost(); });
        // First-time intent prompt (skippable) — NOT when arriving from Deep Research.
        if (!opts.skipIntent && !docCtx.intent && !curDoc.path) openIntentModal(true);
    };

    // ---- topbar (New / Open / Save / Export + AI cluster) -----------------
    function buildTopbar() {
        const host = document.getElementById('doc-topbar-actions');
        if (!host || host.dataset.built) return;
        host.dataset.built = '1';
        const btn = (label, title, fn, cls) => {
            const b = document.createElement('button');
            b.className = 'doc-btn ' + (cls || ''); b.textContent = label; b.title = title; b.onclick = fn;
            return b;
        };
        host.appendChild(btn('＋ New', 'New document', () => newDoc()));
        host.appendChild(btn('Open…', 'Open a document', openDoc));
        host.appendChild(btn('Save', 'Save (⌘/Ctrl+S)', () => saveDoc()));
        host.appendChild(btn('Export ▾', 'Export PDF / DOCX', exportMenu));
        const sep = document.createElement('span'); sep.className = 'doc-sep'; host.appendChild(sep);
        host.appendChild(btn('🎯 Context', 'What are you writing? (LLM context)', () => openIntentModal(false)));
        host.appendChild(btn('✨ Improve', 'Improve the selection', () => aiOnSelection('Improve the clarity, flow and tone of this text')));
        host.appendChild(btn('✓ Grammar', 'Fix grammar of selection', () => aiOnSelection('Fix all spelling and grammar mistakes; keep the meaning')));
        host.appendChild(btn('➡ Continue', 'Continue writing from the cursor', continueWriting));
        const tgl = btn('Suggestions: On', 'Toggle live grammar suggestions', () => {
            suggestOn = !suggestOn; tgl.textContent = 'Suggestions: ' + (suggestOn ? 'On' : 'Off');
            if (!suggestOn) clearAllSuggestions();
        }, 'doc-toggle');
        host.appendChild(tgl);
    }

    // ---- intent modal -----------------------------------------------------
    const INTENTS = ['Resume', 'CV', 'Cover letter', 'Story', 'Book chapter', 'Documentary script',
                     'Notes', 'Blog post', 'Essay', 'Email', 'Formal letter', 'Report', 'README'];
    function openIntentModal(firstTime) {
        closeIntentModal();
        const ov = document.createElement('div');
        ov.id = 'doc-intent-overlay';
        ov.className = 'doc-intent-overlay';
        ov.innerHTML = `
            <div class="doc-intent">
                <h2>What are you writing?</h2>
                <p class="doc-intent-sub">Optional — it just gives the local model context so suggestions and drafts fit your goal.</p>
                <div class="doc-intent-chips" id="doc-intent-chips"></div>
                <input id="doc-intent-topic" placeholder="Add a topic or details (e.g. “backend engineer, 5 yrs Python”)" />
                <div class="doc-intent-actions">
                    <button class="doc-intent-skip" id="doc-intent-skip">${firstTime ? 'Skip — just write' : 'Cancel'}</button>
                    <button class="doc-intent-draft" id="doc-intent-draft">Generate a draft →</button>
                    <button class="doc-intent-save" id="doc-intent-save">Set context</button>
                </div>
            </div>`;
        document.body.appendChild(ov);
        const chips = ov.querySelector('#doc-intent-chips');
        let chosen = docCtx.intent || '';
        INTENTS.forEach(label => {
            const c = document.createElement('button');
            c.className = 'doc-chip' + (chosen === label ? ' active' : '');
            c.textContent = label;
            c.onclick = () => { chosen = label; chips.querySelectorAll('.doc-chip').forEach(x => x.classList.remove('active')); c.classList.add('active'); };
            chips.appendChild(c);
        });
        const topic = ov.querySelector('#doc-intent-topic'); topic.value = docCtx.topic || '';
        ov.querySelector('#doc-intent-skip').onclick = closeIntentModal;
        ov.querySelector('#doc-intent-save').onclick = () => { docCtx = { intent: chosen, topic: topic.value.trim() }; closeIntentModal(); status(`Context: ${chosen || '—'}`); };
        ov.querySelector('#doc-intent-draft').onclick = () => {
            docCtx = { intent: chosen, topic: topic.value.trim() };
            closeIntentModal();
            if (!chosen && !docCtx.topic) { showToast('Pick a type or add a topic first.', 'info'); return; }
            generateDraft();
        };
        setTimeout(() => topic.focus(), 40);
    }
    function closeIntentModal() { const o = document.getElementById('doc-intent-overlay'); if (o) o.remove(); }

    // ---- draft generation (reuses /api/doc/ai-suggest SSE) ----------------
    function generateDraft() {
        if (!q) return;
        q.setText('');
        const instruction = `Write a complete, well-structured ${docCtx.intent || 'document'} in Markdown` +
            (docCtx.topic ? `. Topic/details: ${docCtx.topic}` : '') + '. Use headings and clear formatting.';
        runStream(`/api/doc/ai-suggest?instruction=${encodeURIComponent(instruction)}&text=`, 'Drafting your ' + (docCtx.intent || 'document') + '…');
    }
    function continueWriting() {
        if (!q) return;
        const before = q.getText().slice(-1500);
        const instruction = 'Continue this text naturally for one or two more paragraphs. Return ONLY the continuation.';
        runStream(`/api/doc/ai-suggest?instruction=${encodeURIComponent(instruction)}&text=${encodeURIComponent(before)}`, 'Continuing…');
    }
    function aiOnSelection(instruction) {
        if (!q) return;
        const sel = q.getSelection(true);
        if (!sel || sel.length === 0) { showToast('Select some text first.', 'info'); return; }
        const text = q.getText(sel.index, sel.length);
        // replace the selection with the streamed rewrite
        suppress = true; q.deleteText(sel.index, sel.length); suppress = false;
        q.setSelection(sel.index, 0);
        runStream(`/api/doc/ai-suggest?instruction=${encodeURIComponent(instruction)}&text=${encodeURIComponent(text)}`, 'Rewriting…', sel.index);
    }

    function runStream(url, label, atIndex) {
        if (activeStream) activeStream.stop();
        status(label, true);
        if (typeof atIndex === 'number') { try { q.setSelection(atIndex, 0); } catch (e) {} }
        activeStream = E().createStream(q, url, {
            atSelection: typeof atIndex === 'number',
            onChunk: () => { curDoc.dirty = true; },
            onDone: () => { status('Done.'); activeStream = null; },
            onError: (e) => { showToast('AI error: ' + e, 'error'); status(''); activeStream = null; }
        });
    }

    // ---- live grammar suggestions (Grammarly-style) -----------------------
    function registerSuggestFormat() {
        if (window._docSuggestRegistered || typeof Quill === 'undefined') return;
        const Inline = Quill.import('blots/inline');
        class SuggestBlot extends Inline {}
        SuggestBlot.blotName = 'docsuggest';
        SuggestBlot.className = 'doc-suggest';
        SuggestBlot.tagName = 'span';
        Quill.register(SuggestBlot);
        window._docSuggestRegistered = true;
    }

    let grammarTimer = null;
    let suggestions = [];   // [{original, suggestion, reason}]
    function onDocChange(delta, old, source) {
        if (suppress) return;
        curDoc.dirty = true; status(curDoc.name + ' •');
        hideGhost();
        if (source === 'user' && suggestOn) {
            clearTimeout(grammarTimer);
            grammarTimer = setTimeout(runGrammarCheck, 1200);
        }
        scheduleGhost();
    }

    async function runGrammarCheck() {
        if (!q || !suggestOn) return;
        const text = q.getText();
        if (text.trim().length < 12) return;
        // check only the last ~1500 chars to stay fast/local
        const tail = text.slice(-1500);
        try {
            const res = await fetch('/api/doc/grammar', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: tail, context: docCtx.intent })
            });
            const data = await res.json();
            if (!data || !Array.isArray(data.suggestions)) return;
            clearAllSuggestions();
            suggestions = data.suggestions.filter(s => s.original && s.suggestion && s.original !== s.suggestion).slice(0, 25);
            const full = q.getText();
            suggestions.forEach(s => {
                let from = full.indexOf(s.original);
                if (from === -1) return;
                s.index = from; s.length = s.original.length;
                suppress = true;
                try { q.formatText(from, s.original.length, 'docsuggest', true); } catch (e) {}
                suppress = false;
            });
        } catch (e) { /* offline / model down → silently skip */ }
    }
    function clearAllSuggestions() {
        if (!q) return;
        suppress = true;
        try { q.formatText(0, q.getLength(), 'docsuggest', false); } catch (e) {}
        suppress = false;
        suggestions = [];
        hideSuggestPopover();
    }

    // click a suggestion span → popover with Accept / Dismiss
    document.addEventListener('click', (e) => {
        const span = e.target.closest && e.target.closest('#docstudio-editor .doc-suggest');
        if (!span) { if (!e.target.closest || !e.target.closest('#doc-suggest-popover')) hideSuggestPopover(); return; }
        const idx = q.getIndex(Quill.find(span));
        const s = suggestions.find(s => s.index === idx) || suggestions.find(s => s.original === span.textContent);
        if (s) showSuggestPopover(span, s);
    });
    function showSuggestPopover(span, s) {
        hideSuggestPopover();
        const p = document.createElement('div'); p.id = 'doc-suggest-popover'; p.className = 'doc-suggest-popover';
        p.innerHTML = `<div class="dsp-reason">${(s.reason || 'Suggestion')}</div>
            <div class="dsp-change"><span class="dsp-old">${escapeHtml(s.original)}</span> → <span class="dsp-new">${escapeHtml(s.suggestion)}</span></div>
            <div class="dsp-actions"><button class="dsp-accept">Accept</button><button class="dsp-dismiss">Dismiss</button></div>`;
        document.body.appendChild(p);
        const r = span.getBoundingClientRect();
        p.style.top = (r.bottom + 6) + 'px'; p.style.left = Math.min(r.left, window.innerWidth - p.offsetWidth - 8) + 'px';
        p.querySelector('.dsp-accept').onclick = () => acceptSuggestion(s);
        p.querySelector('.dsp-dismiss').onclick = () => { dismissSuggestion(s); };
    }
    function hideSuggestPopover() { const p = document.getElementById('doc-suggest-popover'); if (p) p.remove(); }
    function acceptSuggestion(s) {
        const full = q.getText();
        const at = full.indexOf(s.original);
        if (at !== -1) {
            suppress = true;
            q.deleteText(at, s.original.length);
            q.insertText(at, s.suggestion);
            q.formatText(at, s.suggestion.length, 'docsuggest', false);
            suppress = false;
            curDoc.dirty = true;
        }
        suggestions = suggestions.filter(x => x !== s);
        hideSuggestPopover();
    }
    function dismissSuggestion(s) {
        const full = q.getText();
        const at = full.indexOf(s.original);
        if (at !== -1) { suppress = true; try { q.formatText(at, s.original.length, 'docsuggest', false); } catch (e) {} suppress = false; }
        suggestions = suggestions.filter(x => x !== s);
        hideSuggestPopover();
    }

    // ---- ghost-text completion -------------------------------------------
    let ghostTimer = null, ghostText = '', ghostIndex = -1;
    function ghostKeyBindings() {
        // Tab accepts the ghost completion when present.
        return {
            acceptGhost: {
                key: 9, // Tab
                handler: function () {
                    if (ghostText && ghostIndex >= 0) { acceptGhost(); return false; }
                    return true; // let Quill insert a tab otherwise
                }
            }
        };
    }
    function wireGhostText() { /* binding registered via makeQuill; nothing else needed */ }
    function scheduleGhost() {
        clearTimeout(ghostTimer);
        if (!suggestOn) return;
        ghostTimer = setTimeout(requestGhost, 650);
    }
    async function requestGhost() {
        if (!q) return;
        const sel = q.getSelection();
        if (!sel) return;
        const len = q.getLength();
        if (sel.index < len - 1) return;            // only complete at the very end
        const before = q.getText().slice(-800).trimEnd();
        if (before.length < 8) return;
        try {
            const res = await fetch('/api/doc/complete', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: before, context: docCtx.intent })
            });
            const data = await res.json();
            const completion = (data && data.completion || '').replace(/\n{3,}/g, '\n\n');
            if (completion && q.getSelection() && q.getSelection().index >= q.getLength() - 1) {
                showGhost(completion, q.getSelection().index);
            }
        } catch (e) { /* model down → no ghost */ }
    }
    function showGhost(text, index) {
        ghostText = text; ghostIndex = index;
        const ov = document.getElementById('docstudio-ghost');
        if (!ov) return;
        let bounds; try { bounds = q.getBounds(index); } catch (e) { return; }
        const host = document.getElementById('docstudio-editor').getBoundingClientRect();
        ov.textContent = text;
        ov.style.left = (bounds.left) + 'px';
        ov.style.top = (bounds.top) + 'px';
        ov.style.maxWidth = (host.width - bounds.left - 24) + 'px';
        ov.classList.remove('hidden');
    }
    function hideGhost() { ghostText = ''; ghostIndex = -1; const ov = document.getElementById('docstudio-ghost'); if (ov) ov.classList.add('hidden'); }
    function acceptGhost() {
        const text = ghostText, at = ghostIndex;
        hideGhost();
        suppress = true; q.insertText(at, text, 'user'); q.setSelection(at + text.length, 0); suppress = false;
        curDoc.dirty = true;
    }

    // ---- file ops: new / open / save / export -----------------------------
    async function newDoc() {
        if (curDoc.dirty && window.showConfirmModal) {
            const ok = await window.showConfirmModal('Discard unsaved changes?', { okLabel: 'Discard', danger: true });
            if (!ok) return;
        }
        q.setText('');
        curDoc = { path: null, name: 'Untitled.md', ext: 'md', dirty: false };
        setTitle('Untitled.md');
        clearAllSuggestions();
        openIntentModal(true);
    }
    // In-app document picker (the native OS picker misbehaves behind a
    // fullscreen window). Lists the workspace's document files.
    async function openDoc() {
        const cwd = document.getElementById('dir-input')?.value || '';
        if (!cwd) { showToast('Open a workspace folder first (in the Cortex IDE).', 'info'); return; }
        try {
            const root = await (await fetch(`/api/workspace/files?cwd=${encodeURIComponent(cwd)}&depth=4`)).json();
            const docs = [];
            (function walk(node, prefix) {
                if (!node || typeof node !== 'object') return;
                Object.keys(node).forEach(k => {
                    if (k === '__lazy__') return;
                    const rel = prefix ? prefix + '/' + k : k;
                    if (node[k] === null) {
                        const ext = E().extOf(k);
                        if (['md', 'markdown', 'txt', 'text', 'doc', 'docx', 'rtf'].includes(ext)) docs.push(rel);
                    } else { walk(node[k], rel); }
                });
            })(root.tree, '');
            if (!docs.length) { showToast('No documents (.md/.txt/.docx) found in the workspace.', 'info'); return; }
            const items = docs.sort().map(rel => ({ label: rel.split('/').pop(), sublabel: rel, value: rel }));
            if (window.showQuickPick) {
                window.showQuickPick('Open document', items, (rel) => loadDocByPath(cwd.replace(/\/$/, '') + '/' + rel));
            }
        } catch (e) { showToast('Open failed: ' + e.message, 'error'); }
    }
    window.docStudioOpenPath = loadDocByPath;
    async function loadDocByPath(path) {
        const ext = E().extOf(path);
        let html = '';
        status('Opening ' + path.split('/').pop() + '…', true);
        try {
            if (['docx', 'doc', 'rtf'].includes(ext)) {
                const d = await (await fetch(`/api/doc/read?path=${encodeURIComponent(path)}`)).json();
                if (d.error) { showToast(d.error, 'error'); status(''); return; }
                html = d.html || E().mdToHtml(d.markdown || d.text || '');
            } else {
                const d = await (await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`)).json();
                if (d.error) { showToast(d.error, 'error'); status(''); return; }
                let content = d.content || '';
                // guard against freezing Quill on very large files
                if (content.length > 500000) { content = content.slice(0, 500000); showToast('Large file truncated for editing.', 'info'); }
                html = (ext === 'md' || ext === 'markdown') ? E().mdToHtml(content) : E().escapeToHtml(content);
            }
        } catch (e) { showToast('Open failed: ' + e.message, 'error'); status(''); return; }
        try {
            suppress = true; q.setContents([]); q.clipboard.dangerouslyPasteHTML(0, E().sanitize(html)); suppress = false;
        } catch (e) { suppress = false; showToast('Could not render this document.', 'error'); status(''); return; }
        curDoc = { path, name: path.split('/').pop(), ext, dirty: false };
        setTitle(curDoc.name);
    }
    async function saveDoc() {
        if (!q) return;
        if (!curDoc.path) {
            const cwd = document.getElementById('dir-input')?.value || '';
            const name = document.getElementById('doc-title').value || 'Untitled.md';
            curDoc.path = (cwd ? cwd.replace(/\/$/, '') + '/' : '') + name;
            curDoc.name = name; curDoc.ext = E().extOf(name) || 'md';
        }
        const html = q.root.innerHTML;
        const content = (curDoc.ext === 'txt' || curDoc.ext === 'text') ? q.getText() : E().htmlToMarkdown(html);
        try {
            const d = await (await fetch('/api/workspace/save', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: curDoc.path, content })
            })).json();
            if (d.success) { curDoc.dirty = false; setTitle(curDoc.name); showToast('Saved ' + curDoc.name, 'success'); if (window.loadWorkspaceFiles) window.loadWorkspaceFiles(); }
            else showToast(d.error || 'Save failed', 'error');
        } catch (e) { showToast('Save failed: ' + e.message, 'error'); }
    }
    function exportMenu() {
        const base = (curDoc.name || 'document').replace(/\.[^.]+$/, '');
        const items = [
            { label: 'PDF — instant (client)', value: () => E().exportClient(q, base, 'pdf') },
            { label: 'DOCX — instant (client)', value: () => E().exportClient(q, base, 'docx') },
            { label: 'PDF — server (ReportLab)', value: () => E().exportServer(q, base, 'pdf') },
            { label: 'DOCX — server (python-docx)', value: () => E().exportServer(q, base, 'docx') }
        ];
        if (window.showQuickPick) window.showQuickPick('Export document', items, (fn) => fn());
        else items[0].value();
    }

    // ---- small helpers ----------------------------------------------------
    function setTitle(name) { curDoc.name = name; const t = document.getElementById('doc-title'); if (t) t.value = name; status(name + (curDoc.dirty ? ' •' : '')); }
    function status(msg, busy) { const s = document.getElementById('doc-statusbar'); if (s) s.textContent = msg || ''; if (s) s.classList.toggle('busy', !!busy); }
    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    // save shortcut for the Document surface
    document.addEventListener('keydown', (e) => {
        if (!document.body.classList.contains('surface-document')) return;
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveDoc(); }
        if (e.key === 'Escape') { hideGhost(); hideSuggestPopover(); }
    });

    // ======================================================================
    // Deep Research surface — query screen → stream report into a document
    // ======================================================================
    window.initResearchStudio = function () {
        const runBtn = document.getElementById('research-run');
        if (!runBtn || runBtn.dataset.wired) return;
        runBtn.dataset.wired = '1';
        renderRecent();
        runBtn.addEventListener('click', startResearch);
        const ta = document.getElementById('research-query');
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startResearch(); });
        setTimeout(() => ta.focus(), 60);
    };
    function recent() { try { return JSON.parse(localStorage.getItem('cortex_research_recent') || '[]'); } catch (e) { return []; } }
    function pushRecent(query) { const r = [query, ...recent().filter(x => x !== query)].slice(0, 6); localStorage.setItem('cortex_research_recent', JSON.stringify(r)); renderRecent(); }
    function renderRecent() {
        const host = document.getElementById('research-recent'); if (!host) return;
        const r = recent(); host.innerHTML = r.length ? '<div class="rr-title">Recent</div>' : '';
        r.forEach(query => { const c = document.createElement('button'); c.className = 'rr-chip'; c.textContent = query; c.onclick = () => { document.getElementById('research-query').value = query; }; host.appendChild(c); });
    }
    function startResearch() {
        const query = (document.getElementById('research-query').value || '').trim();
        if (!query) { showToast('Type a research question first.', 'info'); return; }
        const topic = (document.getElementById('research-topic')?.value || '').trim();
        const depth = document.getElementById('research-depth').value || '5';
        // Use the active model so research isn't stuck on the default llama3.2.
        const model = (window.getEffectiveProvider && window.getEffectiveProvider()) || 'local';
        const title = topic || query;
        pushRecent(query);
        // hand off to the Documents Editor and stream the report into a fresh doc
        window.switchSurface('document');
        setTimeout(() => {
            window.initDocumentStudio({ skipIntent: true });   // no "what are you writing?" on research handoff
            closeIntentModal();   // defensively dismiss any intent modal left open
            if (!q) return;
            q.setText('');
            curDoc = { path: null, name: (title.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')) + '.md', ext: 'md', dirty: true };
            setTitle(curDoc.name);
            const url = `/api/research?query=${encodeURIComponent(query)}&topic=${encodeURIComponent(topic)}`
                + `&max_links=${encodeURIComponent(depth)}&model=${encodeURIComponent(model)}`
                + `&project_id=${encodeURIComponent(projectId())}`;
            runStream(url, 'Researching: ' + title);
        }, 220);
    }
    function projectId() { const cwd = document.getElementById('dir-input')?.value || ''; return cwd ? cwd.replace(/[^a-zA-Z0-9-]/g, '_') : 'default'; }
})();

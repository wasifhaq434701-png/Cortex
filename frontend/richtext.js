// ==========================================================================
// Cortex IDE — Document engine + IDE doc-tab routing.
//
// `window.DocEngine` is the shared toolkit (markdown<->html, sanitize, a Quill
// factory, a ROBUST 30fps SSE streamer, and exporters) reused by both:
//   - the Cortex IDE, which opens .md/.txt/.docx as Quill tabs (this file), and
//   - the standalone Documents Editor + Deep Research surfaces (docstudio.js).
//
// Degrades gracefully if the Quill/DOMPurify/turndown CDNs are unavailable.
// ==========================================================================

(function () {
    'use strict';

    window.DOC_EXTS = ['md', 'markdown', 'txt', 'text', 'doc', 'docx', 'rtf'];
    function extOf(path) {
        const i = (path || '').lastIndexOf('.');
        return i === -1 ? '' : path.slice(i + 1).toLowerCase();
    }
    window.isDocFile = function (path) { return window.DOC_EXTS.includes(extOf(path)); };

    // ======================================================================
    // DocEngine — shared, surface-agnostic toolkit
    // ======================================================================
    function sanitize(html) {
        return (window.DOMPurify ? window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } }) : html);
    }
    function escapeToHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return '<p>' + div.innerHTML.replace(/\n/g, '</p><p>') + '</p>';
    }
    function mdToHtml(md) {
        if (window.marked) {
            try { return sanitize(window.marked.parse(md || '')); } catch (e) { /* fall through */ }
        }
        return escapeToHtml(md);
    }
    let _turndown = null;
    function htmlToMarkdown(html) {
        if (window.TurndownService) {
            if (!_turndown) _turndown = new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
            try { return _turndown.turndown(html || ''); } catch (e) { /* fall through */ }
        }
        const div = document.createElement('div'); div.innerHTML = html || '';
        return div.textContent || '';
    }

    // Expanded font + size pickers (registered once, globally, on Quill).
    const FONT_WHITELIST = ['sans-serif', 'serif', 'monospace', 'arial', 'georgia',
        'times-new-roman', 'courier-new', 'garamond', 'verdana', 'tahoma', 'trebuchet', 'comic-sans'];
    const SIZE_WHITELIST = ['10px', '12px', '14px', '16px', '18px', '20px', '24px', '30px', '36px', '48px'];

    function registerFontsOnce() {
        if (window._docFontsRegistered || typeof Quill === 'undefined') return;
        try {
            const Font = Quill.import('formats/font');
            Font.whitelist = FONT_WHITELIST;
            Quill.register(Font, true);
            const Size = Quill.import('attributors/style/size');
            Size.whitelist = SIZE_WHITELIST;
            Quill.register(Size, true);
            window._docFontsRegistered = true;
        } catch (e) { console.warn('font registration failed', e); }
    }

    function defaultToolbar() {
        return [
            [{ font: FONT_WHITELIST }, { size: SIZE_WHITELIST }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ color: [] }, { background: [] }],
            [{ header: [1, 2, 3, 4, false] }],
            [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }],
            [{ align: [] }],
            ['blockquote', 'code-block', 'link'],
            ['clean']
        ];
    }

    // Build a Quill instance on a selector. Returns null if the CDN is missing.
    function makeQuill(selector, opts) {
        if (typeof Quill === 'undefined') return null;
        registerFontsOnce();
        opts = opts || {};
        const q = new Quill(selector, {
            theme: 'snow',
            placeholder: opts.placeholder || 'Start writing…',
            modules: {
                toolbar: opts.toolbar || defaultToolbar(),
                keyboard: opts.bindings ? { bindings: opts.bindings } : undefined
            }
        });
        if (opts.onTextChange) q.on('text-change', opts.onTextChange);
        return q;
    }

    // Robust 30fps SSE streamer. Accumulates SSE markdown chunks in a
    // non-reactive buffer and re-renders the streamed region into `quill` once
    // per frame (capped at 30fps) as a single batched op. Every Quill call is
    // guarded so a transient selection/paste error can never crash the surface.
    // Returns a handle with .stop().
    function createStream(quill, url, opts) {
        opts = opts || {};
        if (!quill) { if (opts.onError) opts.onError('editor unavailable'); return { stop() {} }; }
        // The scroll container we must not yank while the user reads. Quill's
        // scrolling container is usually the .ql-editor element (quill.root).
        const scroller = (quill.scrollingContainer) || quill.root;
        let sel = null;
        try { sel = quill.getSelection(); } catch (e) { sel = null; }
        let insertAt = (opts.atSelection && sel && typeof sel.index === 'number') ? sel.index : quill.getLength();
        if (typeof insertAt !== 'number' || insertAt < 0) insertAt = Math.max(0, quill.getLength() - 1);

        let buffer = '', rendered = '', renderedLen = 0;
        let raf = null, lastFlush = 0, done = false, es = null;

        function flush() {
            if (buffer === rendered) return;
            const html = mdToHtml(buffer);
            // Preserve the user's scroll position: only auto-follow to the bottom
            // when they're already near it, so they can scroll up and read while
            // the report keeps streaming (the re-render would otherwise yank them).
            let prevTop = 0, nearBottom = true;
            try {
                prevTop = scroller.scrollTop;
                nearBottom = (scroller.scrollHeight - prevTop - scroller.clientHeight) < 120;
            } catch (e) {}
            try {
                if (renderedLen) quill.deleteText(insertAt, renderedLen);
                const before = quill.getLength();
                quill.clipboard.dangerouslyPasteHTML(insertAt, html);
                renderedLen = Math.max(0, quill.getLength() - before);
                rendered = buffer;
                if (opts.onChunk) opts.onChunk(buffer);
            } catch (e) { console.warn('[DocEngine] stream flush failed:', e); }
            try {
                if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
                else scroller.scrollTop = prevTop;
            } catch (e) {}
        }
        function schedule() { if (raf) return; raf = requestAnimationFrame(tick); }
        function tick(ts) {
            raf = null;
            if (ts - lastFlush < 33 && !done) { schedule(); return; }   // cap ~30fps
            lastFlush = ts; flush();
        }
        function finish(err) {
            if (done) return;
            done = true; flush();
            try { if (es) es.close(); } catch (e) {}
            if (err && opts.onError) opts.onError(err);
            if (opts.onDone) opts.onDone();
        }
        try { es = new EventSource(url); }
        catch (e) { finish(e.message || 'stream failed'); return { stop: finish }; }
        es.onmessage = function (ev) {
            let p; try { p = JSON.parse(ev.data); } catch (_) { p = { text: ev.data }; }
            if (p.event === 'done' || p.done) { finish(); return; }
            if (p.error) { finish(p.error); return; }
            buffer += (p.text || p.delta || '');
            schedule();
        };
        es.onerror = function () { finish(); };
        return { stop: function () { finish(); } };
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    }

    function exportClient(quill, name, format) {
        if (!quill) { showToast('Nothing to export.', 'info'); return; }
        name = name || 'document';
        const html = quill.root.innerHTML;
        if (format === 'docx') {
            if (!window.htmlDocx) { showToast('DOCX exporter not loaded.', 'error'); return; }
            downloadBlob(window.htmlDocx.asBlob('<!DOCTYPE html><html><body>' + html + '</body></html>'), name + '.docx');
        } else {
            // PDF: always use the SERVER exporter (ReportLab → black text on a
            // white page). The client jsPDF path captured the dark-themed editor
            // DOM, producing unreadable white-on-white text.
            showToast('Generating PDF…', 'info');
            exportServer(quill, name, 'pdf');
        }
    }

    async function exportServer(quill, name, format) {
        if (!quill) return;
        name = name || 'document';
        try {
            const res = await fetch('/api/export-doc', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ format, title: name, html: quill.root.innerHTML, markdown: htmlToMarkdown(quill.root.innerHTML) })
            });
            if (!res.ok) { showToast('Server export failed.', 'error'); return; }
            downloadBlob(await res.blob(), name + '.' + format);
            showToast('Exported ' + name + '.' + format, 'success');
        } catch (e) { showToast('Server export error: ' + e.message, 'error'); }
    }

    window.DocEngine = {
        extOf, sanitize, mdToHtml, htmlToMarkdown, escapeToHtml,
        defaultToolbar, makeQuill, createStream, exportClient, exportServer, downloadBlob
    };

    // ======================================================================
    // Cortex IDE doc-tab routing — opens .md/.txt/.docx as Quill tabs in the
    // IDE (the polymorphic router). Uses its OWN Quill on #richtext-editor.
    // (Deep Research / writing-assist live in the Documents Editor surface.)
    // ======================================================================
    let quill = null;
    let activeDocTab = null;
    let suppressChange = false;

    function ensureQuill() {
        if (quill) return quill;
        quill = makeQuill('#richtext-editor', {
            placeholder: 'Open a document to edit it here…',
            onTextChange: () => {
                if (suppressChange || !activeDocTab) return;
                if (!activeDocTab.dirty) { activeDocTab.dirty = true; window.renderTabs && window.renderTabs(); }
                if (window.autoSaveEnabled && window.maybeAutoSave) window.maybeAutoSave(activeDocTab);
            }
        });
        return quill;
    }

    function showHost(show) {
        const host = document.getElementById('richtext-container');
        const m1 = document.getElementById('monaco-editor-container');
        const m2 = document.getElementById('monaco-editor-container-2');
        if (host) host.classList.toggle('hidden', !show);
        if (m1) m1.classList.toggle('hidden', show);
        if (m2 && show) m2.classList.add('hidden');
    }

    window.showCodeEditor = function () {
        showHost(false);
        activeDocTab = null;
        if (window.editor) setTimeout(() => window.editor.layout(), 0);
    };

    window.openDocFile = async function (absolutePath, relativePath) {
        const q = ensureQuill();
        if (!q) { showToast('Rich-text editor unavailable (offline?).', 'info'); return; }
        const docExt = extOf(absolutePath);
        let html = '';
        try {
            if (docExt === 'docx' || docExt === 'doc' || docExt === 'rtf') {
                const res = await fetch(`/api/doc/read?path=${encodeURIComponent(absolutePath)}`);
                const data = await res.json();
                if (data.error) { showToast(data.error, 'error'); return; }
                html = data.html || mdToHtml(data.markdown || data.text || '');
            } else {
                const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(absolutePath)}`);
                const data = await res.json();
                if (data.error) { showToast(data.error, 'error'); return; }
                html = (docExt === 'md' || docExt === 'markdown') ? mdToHtml(data.content || '')
                                                                  : escapeToHtml(data.content || '');
            }
        } catch (e) { showToast('Failed to open document: ' + e.message, 'error'); return; }
        const tab = { absolutePath, relativePath, kind: 'doc', docExt, html, dirty: false };
        window.openTabs.push(tab);
        window.switchToTab(absolutePath);
    };

    window.showDocEditor = function (tab) {
        const q = ensureQuill();
        if (!q) return;
        showHost(true);
        activeDocTab = tab;
        suppressChange = true;
        try { q.setContents([]); q.clipboard.dangerouslyPasteHTML(0, sanitize(tab.html || '')); }
        catch (e) { console.warn('showDocEditor paste failed:', e); }
        suppressChange = false;
        setTimeout(() => { try { q.focus(); } catch (e) {} }, 30);
    };

    window.saveDocTab = async function (tab, silent) {
        const q = ensureQuill();
        if (!q || !tab) return false;
        const html = q.root.innerHTML;
        const content = (tab.docExt === 'txt' || tab.docExt === 'text') ? q.getText() : htmlToMarkdown(html);
        try {
            const res = await fetch('/api/workspace/save', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: tab.absolutePath, content })
            });
            const data = await res.json();
            if (data.success) {
                tab.dirty = false; tab.html = html;
                window.renderTabs && window.renderTabs();
                if (!silent) showToast(`Saved ${tab.relativePath.split('/').pop()}`, 'success');
                return true;
            }
            showToast(data.error || 'Save failed', 'error');
            return false;
        } catch (e) { showToast('Save failed: ' + e.message, 'error'); return false; }
    };
})();

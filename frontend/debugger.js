// ==========================================================================
// Cortex IDE — Visual Debugger (DAP client)
// Classic script (loads after studio.js). Speaks plain DAP JSON over
// /api/dap/ws; the backend proxies to the right adapter for the language
// (debugpy / lldb-dap / dlv) and emits cortexDebugError when none exists,
// in which case we fall back to studio.js's terminal CLI debuggers.
// ==========================================================================

window.cortexDebug = {
    ws: null,
    seq: 1,
    pending: {},
    state: 'idle',          // idle | launching | running | stopped
    threadId: null,
    frameId: null,
    stoppedDecorations: [],
    stoppedModel: null,
    programExt: null
};

// Source extensions whose breakpoints are sent to the active adapter
const DAP_EXT_GROUPS = {
    '.py': ['.py'],
    '.c': ['.c', '.h'], '.cpp': ['.cpp', '.cc', '.cxx', '.h', '.hpp'],
    '.cc': ['.cpp', '.cc', '.cxx', '.h', '.hpp'], '.cxx': ['.cpp', '.cc', '.cxx', '.h', '.hpp'],
    '.m': ['.m', '.h'], '.rs': ['.rs'], '.go': ['.go']
};

function dapSend(command, args) {
    const D = window.cortexDebug;
    return new Promise((resolve, reject) => {
        if (!D.ws || D.ws.readyState !== WebSocket.OPEN) {
            reject(new Error('No debug session'));
            return;
        }
        const seq = D.seq++;
        D.pending[seq] = { resolve, reject, command };
        D.ws.send(JSON.stringify({ seq, type: 'request', command, arguments: args || {} }));
    });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

window.dapIsActive = function() {
    return window.cortexDebug.state !== 'idle';
};

window.dapStartSession = function() {
    const D = window.cortexDebug;
    if (D.state !== 'idle') { showToast('A debug session is already running.', 'info'); return; }
    const program = window.activeTabPath;
    if (!program || program.startsWith('untitled:')) {
        showToast('Save the file before debugging.', 'error');
        return;
    }
    const dot = program.lastIndexOf('.');
    const ext = dot === -1 ? '' : program.slice(dot).toLowerCase();
    D.programExt = ext;

    if (window.saveActiveFile) window.saveActiveFile(true);

    D.state = 'launching';
    D.seq = 1;
    D.pending = {};
    clearDebugConsole();
    appendDebugConsole(`Starting debug session: ${program}\n`, 'console');
    openDebugConsoleTab();
    setDebugToolbarVisible(true);
    setDebugToolbarState('running');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/dap/ws`);
    D.ws = ws;

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'cortexInit', ext, program }));
    };
    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        handleDapMessage(msg, program);
    };
    ws.onclose = () => { if (window.cortexDebug.ws === ws) endDebugSession(false); };
    ws.onerror = () => { showToast('Debug connection error.', 'error'); };
};

async function beginDapHandshake(program) {
    try {
        await dapSend('initialize', {
            clientID: 'cortex', clientName: 'Cortex IDE',
            adapterID: window.cortexDebug.programExt === '.py' ? 'debugpy' : 'cortex',
            pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
            supportsVariableType: true, supportsRunInTerminalRequest: false
        });
        // Launch resolves only after configurationDone — do not await it.
        dapSend('launch', { program }).catch(err => {
            appendDebugConsole('Launch failed: ' + err.message + '\n', 'stderr');
            window.dapStop();
        });
    } catch (err) {
        appendDebugConsole('Initialize failed: ' + err.message + '\n', 'stderr');
        endDebugSession(true);
    }
}

function endDebugSession(closeWs) {
    const D = window.cortexDebug;
    if (D.state === 'idle') return;
    D.state = 'idle';
    clearStoppedDecoration();
    setDebugToolbarVisible(false);
    renderDebugVariables(null);
    renderDebugCallStack(null);
    Object.values(D.pending).forEach(p => p.reject(new Error('Session ended')));
    D.pending = {};
    if (closeWs && D.ws) { try { D.ws.close(); } catch (e) {} }
    D.ws = null;
    D.threadId = null;
    D.frameId = null;
    appendDebugConsole('Debug session ended.\n', 'console');
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function handleDapMessage(msg, program) {
    const D = window.cortexDebug;

    if (msg.type === 'response') {
        const p = D.pending[msg.request_seq];
        if (p) {
            delete D.pending[msg.request_seq];
            if (msg.success) p.resolve(msg);
            else p.reject(new Error(msg.message || (p.command + ' failed')));
        }
        return;
    }
    if (msg.type !== 'event') return;

    switch (msg.event) {
        case 'cortexReady':
            beginDapHandshake(program);
            break;
        case 'cortexDebugError': {
            const body = msg.body || {};
            showToast(body.message || 'Debugging unavailable.', 'error');
            if (body.hint) appendDebugConsole((body.message || '') + '\nHint: ' + body.hint + '\n', 'stderr');
            endDebugSession(true);
            // CLI fallback where studio.js has one (pdb / node inspect)
            if (['.py', '.js', '.mjs', '.cjs'].includes(D.programExt) && window.debugActiveFileFallback) {
                showToast('Falling back to terminal debugger.', 'info');
                window.debugActiveFileFallback();
            }
            break;
        }
        case 'initialized':
            (async () => {
                try {
                    await sendAllDapBreakpoints();
                    await dapSend('configurationDone', {});
                    D.state = 'running';
                    setDebugToolbarState('running');
                } catch (e) {
                    appendDebugConsole('Configuration failed: ' + e.message + '\n', 'stderr');
                }
            })();
            break;
        case 'output': {
            const body = msg.body || {};
            appendDebugConsole(body.output || '', body.category || 'stdout');
            break;
        }
        case 'stopped':
            onDapStopped(msg.body || {});
            break;
        case 'continued':
            D.state = 'running';
            setDebugToolbarState('running');
            clearStoppedDecoration();
            break;
        case 'exited':
            appendDebugConsole(`Program exited with code ${msg.body && msg.body.exitCode}.\n`, 'console');
            break;
        case 'terminated':
            endDebugSession(true);
            break;
    }
}

async function onDapStopped(body) {
    const D = window.cortexDebug;
    D.state = 'stopped';
    setDebugToolbarState('stopped');
    try {
        D.threadId = body.threadId ||
            ((await dapSend('threads', {})).body.threads[0] || {}).id;
        const st = await dapSend('stackTrace', { threadId: D.threadId, startFrame: 0, levels: 20 });
        const frames = (st.body && st.body.stackFrames) || [];
        if (body.reason === 'exception' && body.text) {
            appendDebugConsole('Exception: ' + body.text + '\n', 'stderr');
        }
        const top = frames.find(f => f.source && f.source.path);
        renderDebugCallStack(frames);
        if (!top) return;
        D.frameId = top.id;
        await showStoppedLocation(top.source.path, top.line);
        await loadFrameVariables(top.id);
    } catch (e) {
        appendDebugConsole('Failed to inspect stop: ' + e.message + '\n', 'stderr');
    }
}

async function loadFrameVariables(frameId) {
    const sc = await dapSend('scopes', { frameId });
    const scopes = (sc.body && sc.body.scopes) || [];
    const locals = scopes.find(s => /local/i.test(s.name)) || scopes[0];
    if (!locals) { renderDebugVariables([]); return; }
    const v = await dapSend('variables', { variablesReference: locals.variablesReference });
    renderDebugVariables((v.body && v.body.variables) || []);
}

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------

function collectDapBreakpointsByPath() {
    const byPath = {};
    if (window.breakpointsDisabled) return byPath;
    const allowed = DAP_EXT_GROUPS[window.cortexDebug.programExt] || null;
    (window.ideBreakpoints || new Set()).forEach(key => {
        const i = key.lastIndexOf(':');
        if (i === -1) return;
        const uriStr = key.slice(0, i);
        const line = parseInt(key.slice(i + 1), 10);
        if (!uriStr.startsWith('file://') || !line) return;
        let path;
        try { path = monaco.Uri.parse(uriStr).fsPath; } catch (e) { return; }
        if (allowed) {
            const dot = path.lastIndexOf('.');
            const ext = dot === -1 ? '' : path.slice(dot).toLowerCase();
            if (!allowed.includes(ext)) return;
        }
        (byPath[path] = byPath[path] || []).push(line);
    });
    return byPath;
}

let _dapSyncedBpPaths = [];
async function sendAllDapBreakpoints() {
    const byPath = collectDapBreakpointsByPath();
    const paths = new Set([...Object.keys(byPath), ..._dapSyncedBpPaths]);
    _dapSyncedBpPaths = Object.keys(byPath);
    for (const path of paths) {
        const lines = byPath[path] || [];
        await dapSend('setBreakpoints', {
            source: { path },
            breakpoints: lines.map(l => ({ line: l }))
        }).catch(() => {});
    }
}

// Re-send breakpoints live when they change mid-session (F9 / gutter click
// both funnel through studio.js's updateBreakpointsForModel).
(function wrapBreakpointUpdates() {
    const orig = window.updateBreakpointsForModel;
    if (typeof orig !== 'function') return;
    window.updateBreakpointsForModel = function(model) {
        orig(model);
        if (window.dapIsActive && window.dapIsActive() && window.cortexDebug.ws) {
            sendAllDapBreakpoints();
        }
    };
})();

// ---------------------------------------------------------------------------
// Stopped-line decoration + navigation
// ---------------------------------------------------------------------------

async function showStoppedLocation(path, line) {
    if (window.activeTabPath !== path && window.editor) {
        const open = (window.openTabs || []).find(t => t.absolutePath === path);
        if (open && typeof switchToTab === 'function') switchToTab(path);
        else if (window.openAbsoluteFile) await window.openAbsoluteFile(path);
    }
    clearStoppedDecoration();
    if (!window.editor) return;
    const model = window.editor.getModel();
    if (!model) return;
    const D = window.cortexDebug;
    D.stoppedModel = model;
    D.stoppedDecorations = model.deltaDecorations([], [{
        range: new monaco.Range(line, 1, line, 1),
        options: {
            isWholeLine: true,
            className: 'debug-stopped-line',
            glyphMarginClassName: 'debug-stopped-glyph'
        }
    }]);
    window.editor.revealLineInCenterIfOutsideViewport(line);
}

function clearStoppedDecoration() {
    const D = window.cortexDebug;
    if (D.stoppedModel && D.stoppedDecorations.length) {
        try { D.stoppedModel.deltaDecorations(D.stoppedDecorations, []); } catch (e) {}
    }
    D.stoppedDecorations = [];
    D.stoppedModel = null;
}

// ---------------------------------------------------------------------------
// Step / continue / stop / restart
// ---------------------------------------------------------------------------

function _dapStep(command) {
    const D = window.cortexDebug;
    if (D.state !== 'stopped') return;
    clearStoppedDecoration();
    D.state = 'running';
    setDebugToolbarState('running');
    dapSend(command, { threadId: D.threadId }).catch(() => {});
}

window.dapContinue = function() { _dapStep('continue'); };
window.dapStepOver = function() { _dapStep('next'); };
window.dapStepIn = function() { _dapStep('stepIn'); };
window.dapStepOut = function() { _dapStep('stepOut'); };

window.dapStop = function() {
    const D = window.cortexDebug;
    if (D.state === 'idle') return;
    dapSend('terminate', {}).catch(() =>
        dapSend('disconnect', { terminateDebuggee: true }).catch(() => {}));
    setTimeout(() => { if (D.state !== 'idle') endDebugSession(true); }, 2000);
};

window.dapRestart = function() {
    if (!window.dapIsActive()) return window.dapStartSession();
    window.dapStop();
    setTimeout(() => window.dapStartSession(), 600);
};

// F5: start when idle, continue when stopped (VS Code behavior)
window.debugCommandF5 = function() {
    const D = window.cortexDebug;
    if (D.state === 'stopped') window.dapContinue();
    else if (D.state === 'idle') window.debugActiveFile && window.debugActiveFile();
};

// Debug keys work when focus is outside Monaco (toolbar, console, tree)
document.addEventListener('keydown', (e) => {
    if (!window.dapIsActive || !window.dapIsActive()) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') &&
        e.target.id !== 'debug-repl-input') return;
    if (e.key === 'F5' && e.shiftKey) { e.preventDefault(); window.dapStop(); }
    else if (e.key === 'F5' && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); window.debugCommandF5(); }
    else if (e.key === 'F10') { e.preventDefault(); window.dapStepOver(); }
    else if (e.key === 'F11' && e.shiftKey) { e.preventDefault(); window.dapStepOut(); }
    else if (e.key === 'F11') { e.preventDefault(); window.dapStepIn(); }
});

window.addEventListener('beforeunload', () => {
    if (window.cortexDebug.ws) { try { window.cortexDebug.ws.close(); } catch (e) {} }
});

// ---------------------------------------------------------------------------
// Floating debug toolbar
// ---------------------------------------------------------------------------

function ensureDebugToolbar() {
    let bar = document.getElementById('debug-toolbar');
    if (bar) return bar;
    const editorContainer = document.getElementById('monaco-editor-container');
    const host = editorContainer ? editorContainer.parentElement : document.body;
    if (host !== document.body) host.style.position = 'relative';
    bar = document.createElement('div');
    bar.id = 'debug-toolbar';
    bar.className = 'hidden';
    const buttons = [
        { id: 'dbg-continue', label: '▶', title: 'Continue (F5)', fn: () => window.dapContinue() },
        { id: 'dbg-step-over', label: '⤵', title: 'Step Over (F10)', fn: () => window.dapStepOver() },
        { id: 'dbg-step-in', label: '↓', title: 'Step Into (F11)', fn: () => window.dapStepIn() },
        { id: 'dbg-step-out', label: '↑', title: 'Step Out (⇧F11)', fn: () => window.dapStepOut() },
        { id: 'dbg-restart', label: '⟳', title: 'Restart', fn: () => window.dapRestart() },
        { id: 'dbg-stop', label: '■', title: 'Stop (⇧F5)', fn: () => window.dapStop() }
    ];
    buttons.forEach(b => {
        const btn = document.createElement('button');
        btn.id = b.id;
        btn.textContent = b.label;
        btn.title = b.title;
        btn.onclick = b.fn;
        bar.appendChild(btn);
    });
    host.appendChild(bar);
    return bar;
}

function setDebugToolbarVisible(visible) {
    const bar = ensureDebugToolbar();
    bar.classList.toggle('hidden', !visible);
}

function setDebugToolbarState(state) {
    const bar = ensureDebugToolbar();
    const stepping = state === 'stopped';
    ['dbg-continue', 'dbg-step-over', 'dbg-step-in', 'dbg-step-out'].forEach(id => {
        const btn = bar.querySelector('#' + id);
        if (btn) btn.disabled = !stepping;
    });
}

// ---------------------------------------------------------------------------
// Debug Console (bottom panel) + variables / call stack
// ---------------------------------------------------------------------------

function ensureDebugConsole() {
    const container = document.getElementById('debug-console-container');
    if (!container) return null;
    if (container.querySelector('#debug-console-output')) return container;
    container.innerHTML = `
        <div class="debug-console-layout">
            <div class="debug-console-main">
                <div id="debug-console-output"></div>
                <div class="debug-repl-row">
                    <span class="debug-repl-prompt">›</span>
                    <input id="debug-repl-input" placeholder="Evaluate expression (while paused)" autocomplete="off" />
                </div>
            </div>
            <div class="debug-side-panes">
                <div class="debug-side-title">Variables</div>
                <div id="debug-variables"><div class="debug-empty">Not paused</div></div>
                <div class="debug-side-title">Call Stack</div>
                <div id="debug-callstack"><div class="debug-empty">Not paused</div></div>
            </div>
        </div>`;
    const input = container.querySelector('#debug-repl-input');
    input.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const expr = input.value.trim();
        if (!expr) return;
        input.value = '';
        appendDebugConsole('› ' + expr + '\n', 'console');
        const D = window.cortexDebug;
        if (D.state !== 'stopped') {
            appendDebugConsole('Can only evaluate while paused at a breakpoint.\n', 'stderr');
            return;
        }
        try {
            const res = await dapSend('evaluate', { expression: expr, frameId: D.frameId, context: 'repl' });
            appendDebugConsole((res.body && res.body.result || '') + '\n', 'stdout');
        } catch (err) {
            appendDebugConsole(err.message + '\n', 'stderr');
        }
    });
    return container;
}

function openDebugConsoleTab() {
    ensureDebugConsole();
    const bottomPanel = document.querySelector('.studio-bottom-panel');
    if (bottomPanel && bottomPanel.classList.contains('collapsed') && typeof toggleBottomPanel === 'function') {
        toggleBottomPanel();
    }
    const tab = document.querySelector('.studio-bottom-tabs .studio-tab[data-target="debug-console"]');
    if (tab) tab.click();
}

function appendDebugConsole(text, category) {
    const container = ensureDebugConsole();
    if (!container || !text) return;
    const out = container.querySelector('#debug-console-output');
    const span = document.createElement('span');
    span.className = 'dc-' + (category || 'stdout');
    span.textContent = text;
    out.appendChild(span);
    out.scrollTop = out.scrollHeight;
}

function clearDebugConsole() {
    const container = ensureDebugConsole();
    if (!container) return;
    const out = container.querySelector('#debug-console-output');
    if (out) out.innerHTML = '';
}

function renderDebugVariables(variables) {
    const container = ensureDebugConsole();
    if (!container) return;
    const pane = container.querySelector('#debug-variables');
    if (!variables || !variables.length) {
        pane.innerHTML = '<div class="debug-empty">' + (variables ? 'No locals' : 'Not paused') + '</div>';
        return;
    }
    pane.innerHTML = '';
    variables.forEach(v => {
        const row = document.createElement('div');
        row.className = 'debug-var-row';
        row.title = (v.type ? v.type + ' ' : '') + v.name + ' = ' + v.value;
        row.innerHTML = '<span class="debug-var-name"></span><span class="debug-var-value"></span>';
        row.querySelector('.debug-var-name').textContent = v.name;
        row.querySelector('.debug-var-value').textContent = v.value;
        pane.appendChild(row);
    });
}

function renderDebugCallStack(frames) {
    const container = ensureDebugConsole();
    if (!container) return;
    const pane = container.querySelector('#debug-callstack');
    if (!frames || !frames.length) {
        pane.innerHTML = '<div class="debug-empty">Not paused</div>';
        return;
    }
    pane.innerHTML = '';
    frames.forEach((f, i) => {
        const row = document.createElement('div');
        row.className = 'debug-frame-row' + (i === 0 ? ' active' : '');
        const file = f.source && f.source.path ? f.source.path.split('/').pop() : '<unknown>';
        row.textContent = `${f.name}  ${file}:${f.line}`;
        row.onclick = async () => {
            if (window.cortexDebug.state !== 'stopped') return;
            pane.querySelectorAll('.debug-frame-row').forEach(r => r.classList.remove('active'));
            row.classList.add('active');
            window.cortexDebug.frameId = f.id;
            if (f.source && f.source.path) await showStoppedLocation(f.source.path, f.line);
            loadFrameVariables(f.id).catch(() => {});
        };
        pane.appendChild(row);
    });
}

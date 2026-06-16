document.addEventListener('DOMContentLoaded', () => {
    // 1. Pivot Logic
    const switchBtn = document.getElementById('switch-studio-btn');
    const exitBtn = document.getElementById('studio-exit-btn');
    
    // The IDE needs every pixel: go browser-fullscreen while in Studio
    // (like a video player). Safari needs the webkit-prefixed API.
    function enterAppFullscreen() {
        const el = document.documentElement;
        try {
            if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
            else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        } catch (e) {}
    }
    function exitAppFullscreen() {
        try {
            if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
            else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
        } catch (e) {}
    }

    // ===== Surface manager: Chat ↔ {Cortex IDE, Documents Editor, Deep Research} =====
    const STUDIOS = ['ide', 'document', 'research', 'utilities'];
    window.switchSurface = function (name) {
        const body = document.body;
        body.classList.remove('surface-ide', 'surface-document', 'surface-research', 'surface-utilities');
        if (!name || name === 'chat') {
            body.classList.remove('studio-active');
            exitAppFullscreen();
            return;
        }
        body.classList.add('studio-active', 'surface-' + name);
        // Reset any zoom/scroll offset so the fixed-position surface lands
        // flush against the viewport instead of appearing cornered.
        try { window.scrollTo(0, 0); } catch (_) {}
        enterAppFullscreen();
        // Init the chosen surface once its layout is applied.
        setTimeout(() => {
            if (name === 'ide') { initMonacoIfNeeded(); initTerminalIfNeeded(); }
            else if (name === 'document') { window.initDocumentStudio && window.initDocumentStudio(); }
            else if (name === 'research') { window.initResearchStudio && window.initResearchStudio(); }
            else if (name === 'utilities') { window.initUtilitiesStudio && window.initUtilitiesStudio(); }
        }, 100);
    };

    // Back-compat: anything that called toggleStudio() now toggles the IDE surface.
    function toggleStudio() {
        window.switchSurface(document.body.classList.contains('studio-active') ? 'chat' : 'ide');
    }

    // "Switch to Studios ▾" dropdown
    const studiosSwitcher = document.getElementById('studios-switcher');
    function openStudiosMenu() {
        const existing = document.getElementById('studios-menu');
        if (existing) { existing.remove(); return; }
        const items = [
            { id: 'ide', icon: '💻', label: 'Cortex IDE', sub: 'Code, terminal, debugger' },
            { id: 'document', icon: '📝', label: 'Documents Editor', sub: 'Write with local-LLM assist' },
            { id: 'research', icon: '🔎', label: 'Deep Research', sub: 'Agent → synthesized report' }
        ];
        // Only offer "Back to Chat" when we're actually in a studio.
        if (document.body.classList.contains('studio-active')) {
            items.push({ id: 'chat', icon: '💬', label: 'Back to Chat', sub: 'Immersive graph + chat' });
        }
        const menu = document.createElement('div');
        menu.id = 'studios-menu';
        menu.className = 'studios-menu';
        items.forEach(it => {
            const row = document.createElement('div');
            row.className = 'studios-menu-item' + (document.body.classList.contains('surface-' + it.id) ? ' active' : '');
            row.innerHTML = `<span class="sm-icon">${it.icon}</span><span class="sm-text"><span class="sm-label">${it.label}</span><span class="sm-sub">${it.sub}</span></span>`;
            row.onclick = () => { menu.remove(); window.switchSurface(it.id); };
            menu.appendChild(row);
        });
        document.body.appendChild(menu);
        const r = studiosSwitcher.getBoundingClientRect();
        menu.style.top = (r.bottom + 8) + 'px';
        menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
        const dismiss = (e) => {
            if (e.target === studiosSwitcher || menu.contains(e.target)) return;
            menu.remove(); document.removeEventListener('mousedown', dismiss, true);
        };
        document.addEventListener('mousedown', dismiss, true);
    }
    if (studiosSwitcher) studiosSwitcher.addEventListener('click', openStudiosMenu);
    // Utilities is its own header button (no longer in the Studios dropdown).
    const utilitiesSwitcher = document.getElementById('utilities-switcher');
    if (utilitiesSwitcher) utilitiesSwitcher.addEventListener('click', () => window.switchSurface('utilities'));
    if (exitBtn) exitBtn.addEventListener('click', () => window.switchSurface('chat'));

    // Activity Bar Logic
    const sidebar = document.getElementById('studio-sidebar');
    document.querySelectorAll('.activity-btn[data-action="activity-tab"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.currentTarget.getAttribute('data-target');
            if (target === 'copilot') {
                if (typeof toggleCopilotSidebar === 'function') toggleCopilotSidebar();
                return;
            }
            const isActive = e.currentTarget.classList.contains('active');
            
            // If already active and sidebar is open, collapse it
            if (isActive && !sidebar.classList.contains('collapsed')) {
                toggleLeftSidebar();
                return;
            }
            
            // Make sidebar visible if collapsed
            if (sidebar.classList.contains('collapsed')) {
                toggleLeftSidebar();
            }

            // Update active states
            document.querySelectorAll('.activity-btn[data-action="activity-tab"]').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');

            document.querySelectorAll('.studio-sidebar-tabs .studio-tab').forEach(t => t.classList.remove('active'));
            const matchedTab = document.querySelector(`.studio-sidebar-tabs .studio-tab[data-target="${target}"]`);
            if (matchedTab) matchedTab.classList.add('active');

            if (target === 'explorer') {
                loadWorkspaceFiles();
            } else if (target === 'git') {
                loadGitStatus();
            } else if (target === 'search') {
                loadSearchUI();
            }
        });
    });

    // Tab Switching Logic (Sidebar fallback)
    document.querySelectorAll('.studio-sidebar-tabs .studio-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            document.querySelectorAll('.studio-sidebar-tabs .studio-tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            
            const target = e.target.getAttribute('data-target');
            if (target === 'explorer') {
                loadWorkspaceFiles();
            } else if (target === 'git') {
                loadGitStatus();
            }
        });
    });

    // Tab Switching Logic (Bottom Panel)
    document.querySelectorAll('.studio-bottom-tabs .studio-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            document.querySelectorAll('.studio-bottom-tabs .studio-tab').forEach(t => t.classList.remove('active'));
            e.target.classList.add('active');
            
            const targetId = e.target.getAttribute('data-target') + '-container';
            document.querySelectorAll('.studio-panel-content').forEach(panel => {
                if(panel.id === targetId) {
                    panel.classList.add('active');
                    panel.classList.remove('hidden');
                } else {
                    panel.classList.remove('active');
                    if(panel.id !== 'terminal-container') {
                        panel.classList.add('hidden');
                    }
                }
            });

            // Resizing for terminal addon fit if terminal is activated
            if(targetId === 'terminal-container' && window.xtermFitAddon) {
                setTimeout(() => window.xtermFitAddon.fit(), 10);
            }
        });
    });
    
    // Resizer Logic
    const resizerH = document.getElementById('studio-resizer-h');
    const bottomPanel = document.querySelector('.studio-bottom-panel');
    let isResizingH = false;

    resizerH.addEventListener('mousedown', (e) => {
        isResizingH = true;
        document.body.style.cursor = 'row-resize';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizingH) return;
        const newHeight = window.innerHeight - e.clientY;
        if (newHeight > 50 && newHeight < window.innerHeight - 100) {
            bottomPanel.style.height = `${newHeight}px`;
            if (window.editor) window.editor.layout();
            if (window.xtermFitAddon) window.xtermFitAddon.fit();
        }
    });

    document.addEventListener('mouseup', () => {
        isResizingH = false;
        document.body.style.cursor = 'default';
    });

    // Vertical Resizers Logic
    const resizerSidebar = document.getElementById('resizer-sidebar');
    const resizerCopilot = document.getElementById('resizer-copilot');
    const copilotSidebar = document.getElementById('copilot-sidebar');
    const studioMainContainer = document.getElementById('studio-interface');
    
    let isResizingSidebar = false;
    let isResizingCopilot = false;

    if (resizerSidebar) {
        resizerSidebar.addEventListener('mousedown', (e) => {
            isResizingSidebar = true;
            document.body.style.cursor = 'col-resize';
            studioMainContainer.style.pointerEvents = 'none';
        });
    }

    if (resizerCopilot) {
        resizerCopilot.addEventListener('mousedown', (e) => {
            isResizingCopilot = true;
            document.body.style.cursor = 'col-resize';
            studioMainContainer.style.pointerEvents = 'none';
        });
    }

    document.addEventListener('mousemove', (e) => {
        if (isResizingSidebar) {
            // Calculate width based on left offset (approx 48px for activity bar)
            const newWidth = e.clientX - 48;
            if (newWidth > 150 && newWidth < window.innerWidth / 2) {
                sidebar.style.width = `${newWidth}px`;
                if (window.editor) window.editor.layout();
                if (window.fitVisibleTerminals) window.fitVisibleTerminals();
            }
        }
        if (isResizingCopilot) {
            // Calculate width based on right offset
            const newWidth = window.innerWidth - e.clientX;
            if (newWidth > 200 && newWidth < window.innerWidth / 2) {
                copilotSidebar.style.width = `${newWidth}px`;
                if (window.editor) window.editor.layout();
                if (window.fitVisibleTerminals) window.fitVisibleTerminals();
            }
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizingSidebar || isResizingCopilot) {
            isResizingSidebar = false;
            isResizingCopilot = false;
            document.body.style.cursor = 'default';
            studioMainContainer.style.pointerEvents = 'auto';
        }
    });

    // Textarea auto-expand logic
    const copilotInput = document.getElementById('copilot-input');
    if (copilotInput) {
        copilotInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
        });
    }

    // Fetch local models for Copilot Select
    fetchLocalModels();

    // Wire the attach (+) and microphone buttons (works without the worker)
    initCopilotInputControls();

    // Optional JIT tokenizer worker — attach/mic must not depend on it
    try { initModelWorker(); } catch (e) { console.warn('Tokenizer worker unavailable:', e); }

window.currentInteractionMode = 'agent';

// ===== Agent modes (Claude Code-style) =====
// 'ask-permission' — agent asks before each file edit (default)
// 'accept-edits'   — file edits are applied automatically
// 'plan'           — agent produces a plan blueprint you approve first
// Shell commands always require approval, in every mode.
const AGENT_MODES = [
    { id: 'ask-permission', label: '⏵⏵ Ask permission', hint: 'Agent asks before editing files' },
    { id: 'accept-edits', label: '⏵⏵ Accept edits', hint: 'File edits are applied automatically' },
    { id: 'plan', label: '⏸ Plan mode', hint: 'Agent plans first and waits for your approval' }
];
window.agentMode = localStorage.getItem('cortex_agent_mode') || 'ask-permission';
if (!AGENT_MODES.some(m => m.id === window.agentMode)) window.agentMode = 'ask-permission';

function refreshAgentModeBtn() {
    const btn = document.getElementById('copilot-mode-btn');
    if (!btn) return;
    const mode = AGENT_MODES.find(m => m.id === window.agentMode) || AGENT_MODES[0];
    btn.textContent = mode.label;
    btn.title = mode.hint + ' — click to change';
    btn.classList.toggle('mode-plan', mode.id === 'plan');
    btn.classList.toggle('mode-auto', mode.id === 'accept-edits');
}

window.setAgentMode = function(modeId) {
    if (!AGENT_MODES.some(m => m.id === modeId)) return;
    window.agentMode = modeId;
    localStorage.setItem('cortex_agent_mode', modeId);
    refreshAgentModeBtn();
};

// Anchored popup above the pill (Claude Code-style mode menu)
function toggleAgentModeMenu() {
    const existing = document.getElementById('agent-mode-menu');
    if (existing) { existing.remove(); return; }
    const btn = document.getElementById('copilot-mode-btn');
    if (!btn) return;

    const menu = document.createElement('div');
    menu.id = 'agent-mode-menu';

    const header = document.createElement('div');
    header.className = 'agent-mode-menu-header';
    header.textContent = 'Mode';
    menu.appendChild(header);

    AGENT_MODES.forEach(m => {
        const row = document.createElement('div');
        row.className = 'agent-mode-menu-item' + (m.id === window.agentMode ? ' active' : '');
        row.title = m.hint;
        const label = document.createElement('span');
        label.textContent = m.label.replace(/^[⏵⏸]+ /, '');
        const check = document.createElement('span');
        check.className = 'agent-mode-check';
        check.textContent = m.id === window.agentMode ? '✓' : '';
        row.appendChild(label);
        row.appendChild(check);
        row.onclick = () => { window.setAgentMode(m.id); menu.remove(); };
        menu.appendChild(row);
    });

    document.body.appendChild(menu);
    // Anchor above the pill, opening upward like Claude Code's selector
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = (r.top - menu.offsetHeight - 8) + 'px';

    const dismiss = (e) => {
        if (e.target === btn || menu.contains(e.target)) return;
        menu.remove();
        document.removeEventListener('mousedown', dismiss, true);
        document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => { if (e.key === 'Escape') dismiss({ target: document.body }); };
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
}

(function initAgentModeBtn() {
    const btn = document.getElementById('copilot-mode-btn');
    if (!btn) return;
    btn.addEventListener('click', toggleAgentModeMenu);
    refreshAgentModeBtn();
})();

// Copilot Chat Submission Logic
const copilotSendBtn = document.getElementById('copilot-send-btn');
const copilotHistory = document.getElementById('copilot-chat-history');

// Base64 of an image attached to the Copilot (one-shot, cleared after send) so
// it can ride along to a vision-capable model via the brain ws `images` field.
let copilotImageB64 = null;
// True while a Copilot generation is in flight (drives the stop button).
let copilotProcessing = false;

window.brainWs = null;
let brainWsConnected = false;

function connectBrainWebSocket() {
    if (window.brainWs && window.brainWs.readyState === WebSocket.OPEN) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    window.brainWs = new WebSocket(`${protocol}//${window.location.host}/api/brain/ws`);
    
    window.brainWs.onopen = () => {
        brainWsConnected = true;
        console.log("Brain WebSocket connected");
    };
    
    window.brainWs.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleBrainMessage(data);
    };
    
    window.brainWs.onclose = () => {
        brainWsConnected = false;
        console.log("Brain WebSocket disconnected");
        window.activeResponseDiv = null;
        unlockMonacoFailsafe();
        if (typeof setCopilotProcessing === 'function') setCopilotProcessing(false);
        setTimeout(connectBrainWebSocket, 3000);
    };

    window.brainWs.onerror = () => {
        console.error("Brain WebSocket error");
        window.activeResponseDiv = null;
        unlockMonacoFailsafe();
        if (typeof setCopilotProcessing === 'function') setCopilotProcessing(false);
    };
}

function unlockMonacoFailsafe() {
    if (window.editor) {
        window.editor.updateOptions({ readOnly: false });
    }
}

function lockMonacoEditor() {
    if (window.editor) {
        window.editor.updateOptions({ readOnly: true });
    }
}

window.activeResponseDiv = null;

function getActiveChatContainer() {
    if (document.body.classList.contains('studio-active')) {
        return document.getElementById('copilot-chat-history');
    }
    return document.getElementById('chat-output');
}

function handleBrainMessage(data) {
    const container = getActiveChatContainer();
    
    if (!window.activeResponseDiv && data.type !== 'plan_blueprint' && data.type !== 'cli_permission_request' && data.type !== 'state_change' && data.type !== 'task_update' && data.type !== 'edit_permission_request' && data.type !== 'file_written') {
        window.activeResponseDiv = document.createElement('div');
        
        if (container.id === 'chat-output') {
            window.activeResponseDiv.className = 'chat-msg ai';
        } else {
            window.activeResponseDiv.style.cssText = "background: transparent; padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; color: var(--text-secondary); align-self: flex-start; margin-top: 10px; max-width: 90%; white-space: pre-wrap;";
        }
        container.appendChild(window.activeResponseDiv);
    }

    switch(data.type) {
        case 'chunk':
            if (window.activeResponseDiv) window.activeResponseDiv.textContent += data.content;
            break;
        case 'done':
            // Format the finished main-chat message (markdown, code boxes, and
            // <CHART>/<MERMAID> blocks) — chunks stream in as raw text.
            if (window.activeResponseDiv && container && container.id === 'chat-output'
                && typeof formatChatMessage === 'function') {
                try {
                    const raw = window.activeResponseDiv.textContent || '';
                    window.activeResponseDiv.innerHTML = formatChatMessage(raw);
                    if (typeof initPendingCharts === 'function') initPendingCharts();
                    // Persist the RAW source (markdown + <CHART>/code fences) so the
                    // answer survives reloads/session-switches and re-renders fully.
                    // Expose it too, for the genMode auto-export in app-v12.js.
                    window.lastAiRawResponse = raw;
                    if (raw.trim() && typeof saveMessageToSession === 'function') {
                        saveMessageToSession('ai', raw,
                            '<div class="chat-msg ai">' + window.activeResponseDiv.innerHTML + '</div>');
                    }
                } catch (_) {}
            }
            window.activeResponseDiv = null;
            if (typeof setCopilotProcessing === 'function') setCopilotProcessing(false);
            break;
        case 'plan_blueprint':
            renderPlanBlueprint(data.plan, container);
            break;
        case 'state_change':
            if (data.state === 'EXECUTING') {
                lockMonacoEditor();
            } else if (data.state === 'COMPLETED' || data.state === 'FAILED') {
                unlockMonacoFailsafe();
                window.activeResponseDiv = null; // start fresh for walkthrough
                if (typeof setCopilotProcessing === 'function') setCopilotProcessing(false);
            }
            break;
        case 'task_update':
            updateTaskUI(data.step, data.status);
            break;
        case 'walkthrough_chunk':
            if (window.activeResponseDiv) window.activeResponseDiv.textContent += data.content;
            break;
        case 'walkthrough_done':
            window.activeResponseDiv = null;
            if (typeof setCopilotProcessing === 'function') setCopilotProcessing(false);
            break;
        case 'cli_permission_request':
            showCliPermissionModal(data.command);
            break;
        case 'edit_permission_request':
            showEditPermissionModal(data.path, data.content_preview, data.total_lines);
            break;
        case 'file_written':
            handleAgentFileWritten(data.path);
            break;
    }
    // Only auto-follow if the user is already near the bottom — otherwise a
    // forced scroll on every streamed chunk traps them and they can't scroll up.
    stickToBottom(container);
}

// Scroll an element to the bottom ONLY when the user is already near it, so
// streaming output doesn't yank the viewport away while they read older text.
function stickToBottom(el) {
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
}
window.stickToBottom = stickToBottom;

// Agent wrote a file on disk: reload it in any clean open tab and refresh the tree
let _treeRefreshTimer = null;
function handleAgentFileWritten(path) {
    const tab = (window.openTabs || []).find(t => t.absolutePath === path);
    if (tab && tab.model) {
        if (tab.dirty) {
            showToast(`Agent modified ${path.split('/').pop()} on disk — your unsaved changes were kept.`, 'info');
        } else {
            fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`)
                .then(r => r.json())
                .then(d => {
                    if (d.error || typeof d.content !== 'string') return;
                    const isActive = window.activeTabPath === path && window.editor;
                    const viewState = isActive ? window.editor.saveViewState() : null;
                    tab.model.setValue(d.content);
                    tab.dirty = false;
                    if (isActive && viewState) window.editor.restoreViewState(viewState);
                    window.renderTabs && window.renderTabs();
                })
                .catch(() => {});
        }
    }
    // Debounced tree refresh so new files appear (expansion state is preserved)
    clearTimeout(_treeRefreshTimer);
    _treeRefreshTimer = setTimeout(() => loadWorkspaceFiles(), 400);
}

function showEditPermissionModal(path, preview, totalLines) {
    let modal = document.getElementById('edit-permission-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'edit-permission-modal';
        modal.style.cssText = "position: absolute; bottom: 20px; right: 20px; width: 420px; max-width: 90vw; background: var(--background); border: 1px solid var(--accent); padding: 15px; border-radius: 8px; z-index: 100; box-shadow: 0 4px 12px rgba(0,0,0,0.5);";
        document.body.appendChild(modal);
    }

    const shownLines = (preview || '').split('\n').length;
    const more = totalLines && totalLines > shownLines ? `\n… (${totalLines - shownLines} more lines)` : '';
    modal.innerHTML = `
        <h4 style="margin:0 0 6px 0; color:var(--accent);">✏️ File Edit Request</h4>
        <div style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:8px; word-break:break-all;"></div>
        <pre style="background:var(--background-darker); padding:8px; overflow:auto; max-height:220px; font-size:0.75rem; margin-bottom:10px; color:var(--text-primary);"></pre>
        <div style="display:flex; gap:10px;">
            <button id="edit-accept-btn" style="flex:1; padding:8px; background:var(--success); color:#fff; border:none; border-radius:4px; cursor:pointer;">Apply Edit</button>
            <button id="edit-reject-btn" style="flex:1; padding:8px; background:var(--danger); color:#fff; border:none; border-radius:4px; cursor:pointer;">Reject</button>
        </div>
    `;
    modal.querySelector('div').textContent = path;
    modal.querySelector('pre').textContent = (preview || '') + more;
    modal.style.display = 'block';

    document.getElementById('edit-accept-btn').onclick = () => {
        window.brainWs.send(JSON.stringify({ type: 'edit_approval', approved: true }));
        modal.style.display = 'none';
    };
    document.getElementById('edit-reject-btn').onclick = () => {
        window.brainWs.send(JSON.stringify({ type: 'edit_approval', approved: false }));
        modal.style.display = 'none';
    };
}

function renderPlanBlueprint(plan, container) {
    const planDiv = document.createElement('div');
    planDiv.style.cssText = "background: rgba(15, 23, 42, 0.8); border: 1px solid var(--accent); padding: 12px; border-radius: 8px; margin-top: 10px; font-size: 0.85rem; color: #fff;";
    
    let html = `<h4 style="margin:0 0 10px 0; color:var(--accent);">Plan Blueprint</h4>`;
    html += `<p style="margin-bottom:10px;">${plan.plan_summary || ''}</p>`;
    
    html += `<ul id="agent-tasks-list" style="padding-left:20px; margin-bottom:10px;">`;
    (plan.tasks || []).forEach((task, id) => {
        html += `<li id="task-item-${id+1}">${task}</li>`;
    });
    html += `</ul>`;
    
    if (plan.agent_questions && plan.agent_questions.length > 0) {
        html += `<p style="color:var(--warning); margin-bottom:5px;">Agent Questions:</p><ul style="padding-left:20px; color:var(--warning); margin-bottom:10px;">`;
        plan.agent_questions.forEach(q => {
            html += `<li>${q}</li>`;
        });
        html += `</ul>`;
    }
    
    const btnId = 'approve-plan-btn-' + Date.now();
    const inputId = 'plan-feedback-input-' + Date.now();
    
    html += `<input type="text" id="${inputId}" placeholder="Add Warnings / Constraints..." style="width:100%; padding:8px; margin-bottom:10px; background:var(--background-darker); border:1px solid var(--glass-border); color:#fff; border-radius:4px;" />`;
    html += `<button id="${btnId}" style="width:100%; padding:8px; background:var(--accent); color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:bold;">Approve Plan & Proceed</button>`;
    
    planDiv.innerHTML = html;
    container.appendChild(planDiv);
    container.scrollTop = container.scrollHeight;
    
    document.getElementById(btnId).addEventListener('click', () => {
        const feedback = document.getElementById(inputId).value;
        document.getElementById(btnId).textContent = "Approved ✓";
        document.getElementById(btnId).disabled = true;
        document.getElementById(inputId).disabled = true;
        window.brainWs.send(JSON.stringify({ type: 'plan_approval', feedback }));
    });
}

function updateTaskUI(step, status) {
    const taskLi = document.getElementById(`task-item-${step}`);
    if (taskLi) {
        if (status === 'running') {
            taskLi.style.color = 'var(--accent)';
            taskLi.innerHTML = `⏳ ${taskLi.textContent.replace(/^([⏳✅❌] )+/, '')}`;
        } else if (status === 'completed') {
            taskLi.style.color = 'var(--success)';
            taskLi.innerHTML = `✅ ${taskLi.textContent.replace(/^([⏳✅❌] )+/, '')}`;
        }
    }
}

function showCliPermissionModal(command) {
    let modal = document.getElementById('cli-permission-modal');
    const copilotSidebar = document.getElementById('copilot-sidebar');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'cli-permission-modal';
        // Anchor it just above the Copilot chat input (inside the sidebar) and
        // give it a real, OPAQUE background (the old var(--background) didn't
        // exist → it rendered transparent and unreadable).
        modal.style.cssText = "position: absolute; bottom: 92px; left: 12px; right: 12px; background: var(--bg-secondary, #1e1e1e); border: 1px solid var(--danger); padding: 14px; border-radius: 10px; z-index: 1200; box-shadow: 0 8px 28px rgba(0,0,0,0.45);";
        (copilotSidebar || document.body).appendChild(modal);
    }

    modal.innerHTML = `
        <h4 style="margin:0 0 10px 0; color:var(--danger);">⚠️ CLI Execution Request</h4>
        <pre style="background:var(--bg-input, rgba(0,0,0,0.25)); padding:8px; overflow-x:auto; font-size:0.8rem; margin-bottom:10px; color:var(--text-primary); border-radius:6px; white-space:pre-wrap; word-break:break-all;">${command}</pre>
        <div style="display:flex; gap:10px;">
            <button id="cli-accept-btn" style="flex:1; padding:8px; background:var(--success); color:#fff; border:none; border-radius:4px; cursor:pointer;">Accept & Run</button>
            <button id="cli-reject-btn" style="flex:1; padding:8px; background:var(--danger); color:#fff; border:none; border-radius:4px; cursor:pointer;">Reject / Abort</button>
        </div>
    `;
    modal.style.display = 'block';
    
    document.getElementById('cli-accept-btn').onclick = () => {
        window.brainWs.send(JSON.stringify({ type: 'cli_approval', approved: true }));
        modal.style.display = 'none';
    };
    document.getElementById('cli-reject-btn').onclick = () => {
        window.brainWs.send(JSON.stringify({ type: 'cli_approval', approved: false }));
        modal.style.display = 'none';
    };
}

// Connect on load
connectBrainWebSocket();

function setCopilotProcessing(on) {
    copilotProcessing = !!on;
    if (!copilotSendBtn) return;
    if (on) {
        copilotSendBtn.classList.add('stop-mode');
        copilotSendBtn.title = 'Stop generation';
        copilotSendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
    } else {
        copilotSendBtn.classList.remove('stop-mode');
        copilotSendBtn.title = 'Send message';
        copilotSendBtn.innerHTML = '➤';
    }
}
window.setCopilotProcessing = setCopilotProcessing;

async function sendCopilotMessage() {
    // While a generation is in flight, the button acts as a STOP: tell the
    // server to break its loop (freeing the model) and reset the UI.
    if (copilotProcessing) {
        try {
            if (window.brainWs && window.brainWs.readyState === WebSocket.OPEN) {
                window.brainWs.send(JSON.stringify({ type: 'cancel', interaction_mode: 'cancel' }));
            }
        } catch (_) {}
        window.activeResponseDiv = null;
        setCopilotProcessing(false);
        unlockMonacoFailsafe();
        return;
    }

    const text = copilotInput.value.trim();
    if (!text) return;

    if (!brainWsConnected) {
        alert("Brain WebSocket is not connected. Reconnecting...");
        connectBrainWebSocket();
        return;
    }
    
    // UI Feedback
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = "background: var(--accent-glow, rgba(255,255,255,0.1)); padding: 8px 12px; border-radius: 8px; font-size: 0.85rem; color: var(--text-primary, #fff); align-self: flex-end; margin-top: 10px; max-width: 90%;";
    const textSpan = document.createElement('div');
    textSpan.textContent = text;
    msgDiv.appendChild(textSpan);
    // Copy / edit actions under the user message.
    const acts = document.createElement('div');
    acts.style.cssText = "display:flex;gap:6px;justify-content:flex-end;margin-top:4px;";
    const mkBtn = (label, title, fn) => {
        const b = document.createElement('button');
        b.textContent = label; b.title = title;
        b.style.cssText = "background:transparent;border:none;cursor:pointer;font-size:0.8rem;opacity:0.7;";
        b.onclick = fn; return b;
    };
    acts.appendChild(mkBtn('📋', 'Copy', () => navigator.clipboard.writeText(text)));
    acts.appendChild(mkBtn('✏️', 'Edit / resend', () => { copilotInput.value = text; copilotInput.focus(); }));
    msgDiv.appendChild(acts);
    copilotHistory.appendChild(msgDiv);
    copilotHistory.scrollTop = copilotHistory.scrollHeight;
    
    copilotInput.value = '';
    copilotInput.style.height = '40px';
    
    // Build context
    let activeFilePath = "";
    let selectedText = "";
    if (window.editor) {
        const model = window.editor.getModel();
        if (model) {
            if (model.uri && model.uri.scheme === 'file') {
                activeFilePath = model.uri.path;
            } else if (window.activeTabPath) {
                activeFilePath = window.activeTabPath;
            }
            const selection = window.editor.getSelection();
            if (selection && !selection.isEmpty()) {
                selectedText = model.getValueInRange(selection);
            } else {
                selectedText = model.getValue(); 
            }
        }
    }
    
    const activeModel = document.getElementById('copilot-model-select') ? document.getElementById('copilot-model-select').value : 'local:llama3.2';
    
    const cwd = document.getElementById('dir-input')?.value || "";
    const projectId = cwd ? cwd.replace(/[^a-zA-Z0-9-]/g, '_') : "default";
    
    const payload = {
        interaction_mode: 'agent',
        agent_mode: window.agentMode || 'ask-permission',
        model: activeModel,
        prompt: text,
        ui_context: {
            active_file_path: activeFilePath,
            selected_text: selectedText,
            workspace_dir: cwd
        },
        project_id: projectId,
        images: copilotImageB64 ? [copilotImageB64] : []
    };
    // One-shot: the image rides along with this turn, then is cleared.
    copilotImageB64 = null;
    const jitWarn = document.getElementById('jit-tokenizer-warning');
    if (jitWarn) jitWarn.classList.add('hidden');

    window.brainWs.send(JSON.stringify(payload));
    setCopilotProcessing(true);
}

if (copilotSendBtn) {
    copilotSendBtn.addEventListener('click', sendCopilotMessage);
}

if (copilotInput) {
    copilotInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendCopilotMessage();
        }
    });
}

    // Keyboard Shortcuts (Cmd+B, Cmd+J, Cmd+I)
    window.addEventListener('keydown', handleGlobalShortcuts);

    // Initial load for explorer
    const savedDir = localStorage.getItem('last_workspace_dir');
    const dirInput = document.getElementById('dir-input');
    if (savedDir) {
        if (dirInput) dirInput.value = savedDir;
        loadWorkspaceFiles();
    }
    // Show the IDE Welcome (Start + Recent) when nothing is open, instead of
    // auto-popping a native folder picker on startup.
    if (typeof ideUpdateWelcome === 'function') ideUpdateWelcome();
});

function handleGlobalShortcuts(e) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const modifier = isMac ? e.metaKey : e.ctrlKey;
    
    if (modifier && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 's' && e.shiftKey) {
            e.preventDefault();
            if (typeof saveAllFiles === 'function') saveAllFiles();
            return;
        }
        if (e.shiftKey) return;
        if (k === 'b') {
            e.preventDefault();
            toggleLeftSidebar();
        } else if (k === 'j') {
            e.preventDefault();
            toggleBottomPanel();
        } else if (k === 'i') {
            e.preventDefault();
            toggleCopilotSidebar();
        } else if (k === 's') {
            e.preventDefault();
            if (typeof saveActiveFile === 'function') saveActiveFile();
        } else if (k === 'w' && document.body.classList.contains('studio-active')) {
            if (window.activeTabPath) {
                e.preventDefault();
                closeTab(null, window.activeTabPath);
            }
        }
    }
}

let lastLeftSidebarWidth = '250px';
function toggleLeftSidebar() {
    const sidebar = document.getElementById('studio-sidebar');
    const resizer = document.getElementById('resizer-sidebar');
    if (sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
        sidebar.style.width = lastLeftSidebarWidth;
        sidebar.style.display = 'flex';
        if (resizer) resizer.style.display = 'block';
    } else {
        lastLeftSidebarWidth = sidebar.style.width || '250px';
        sidebar.classList.add('collapsed');
        sidebar.style.width = '0px';
        sidebar.style.display = 'none';
        if (resizer) resizer.style.display = 'none';
    }
    if (window.editor) setTimeout(() => window.editor.layout(), 50);
}

let lastBottomHeight = '250px';
function toggleBottomPanel() {
    const bottomPanel = document.querySelector('.studio-bottom-panel');
    const resizer = document.getElementById('studio-resizer-h');
    if (bottomPanel.classList.contains('collapsed')) {
        bottomPanel.classList.remove('collapsed');
        let h = parseInt(lastBottomHeight) || 250;
        if (h < 100) h = 250;
        bottomPanel.style.height = h + 'px';
        bottomPanel.style.display = 'flex';
        if (resizer) resizer.style.display = 'block';
        setTimeout(() => {
            if (window.xtermFitAddon) window.xtermFitAddon.fit();
            if (window.editor) window.editor.layout();
        }, 100);
    } else {
        lastBottomHeight = bottomPanel.style.height || '250px';
        bottomPanel.classList.add('collapsed');
        bottomPanel.style.height = '0px';
        bottomPanel.style.display = 'none';
        if (resizer) resizer.style.display = 'none';
        setTimeout(() => { if (window.editor) window.editor.layout(); }, 50);
    }
}

let lastCopilotWidth = '350px';
function toggleCopilotSidebar() {
    const copilotSidebar = document.getElementById('copilot-sidebar');
    const resizer = document.getElementById('resizer-copilot');
    if (copilotSidebar.classList.contains('collapsed')) {
        copilotSidebar.classList.remove('collapsed');
        copilotSidebar.style.width = lastCopilotWidth;
        copilotSidebar.style.display = 'flex';
        if (resizer) resizer.style.display = 'block';
    } else {
        lastCopilotWidth = copilotSidebar.style.width || '350px';
        copilotSidebar.classList.add('collapsed');
        copilotSidebar.style.width = '0px';
        copilotSidebar.style.display = 'none';
        if (resizer) resizer.style.display = 'none';
    }
    if (window.editor) setTimeout(() => window.editor.layout(), 50);
}

// Workspace File Tree
// Folders the user has expanded (by workspace-relative path); survives
// re-renders (refresh button, agent-triggered refreshes) so the tree
// doesn't snap shut. Reset when the workspace cwd changes.
window.expandedTreePaths = window.expandedTreePaths || new Set();
let _treeCwd = null;

function _treePathId(path) {
    let h = 5381;
    for (let i = 0; i < path.length; i++) h = ((h << 5) + h + path.charCodeAt(i)) >>> 0;
    return 'dir-' + h.toString(36);
}

async function loadWorkspaceFiles() {
    const cwd = document.getElementById('dir-input')?.value || "";
    const contentArea = document.getElementById('studio-sidebar-content');
    if (cwd !== _treeCwd) {
        window.expandedTreePaths.clear();
        _treeCwd = cwd;
    }
    try {
        const url = cwd ? `/api/workspace/files?cwd=${encodeURIComponent(cwd)}` : `/api/workspace/files`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error && contentArea) {
            contentArea.innerHTML = `<div style="padding: 10px; color: var(--danger); font-size: 0.8rem;">${data.error}</div>`;
        } else if (contentArea) {
            const headerHtml = `
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px solid var(--glass-border); text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; color: var(--text-muted);">
                    <span>Workspace</span>
                    <div style="display: flex; gap: 8px; font-size: 1rem;">
                        <span title="New File" style="cursor:pointer;" onclick="createFile()">📄</span>
                        <span title="New Folder" style="cursor:pointer;" onclick="createFolder()">📁</span>
                        <span title="Refresh Explorer" style="cursor:pointer;" onclick="loadWorkspaceFiles()">🔄</span>
                        <span title="Collapse All" style="cursor:pointer;" onclick="collapseAllDirs()">⊟</span>
                    </div>
                </div>
            `;
            try {
                contentArea.innerHTML = headerHtml + renderTree(data.tree, '');
                restoreTreeExpansion();   // re-open previously expanded folders (lazy)
            } catch (rErr) {
                console.error('Tree render failed', rErr);
                contentArea.innerHTML = headerHtml + '<div style="padding:10px;color:var(--danger);font-size:0.8rem;">Could not render the file tree.</div>';
            }
        }
    } catch (err) {
        console.error('Failed to load workspace files', err);
        if (contentArea) contentArea.innerHTML = '<div style="padding:10px;color:var(--danger);font-size:0.8rem;">Failed to load workspace.</div>';
    }
}

function renderTree(tree, pathPrefix = "", depth = 0) {
    if (typeof tree !== 'object' || tree === null) return '';
    let html = '<ul style="list-style: none; padding-left: 12px; margin: 4px 0; font-size: 0.85rem; color: var(--text-secondary);">';
    const keys = Object.keys(tree).sort((a, b) => {
        const aIsDir = tree[a] !== null;
        const bIsDir = tree[b] !== null;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
    });

    for (const key of keys) {
        const isDir = tree[key] !== null;
        // Build full path
        const fullPath = pathPrefix ? `${pathPrefix}/${key}` : key;
        
        if (isDir) {
            const dirId = _treePathId(fullPath);
            const escapedDirPath = fullPath.replace(/'/g, "\\'");
            const attrDir = `data-relpath="${escapeAttr(fullPath)}" data-isdir="1"`;
            const childVal = tree[key];
            const isLazy = childVal && childVal.__lazy__ === true;
            // Lazy dirs render collapsed with an empty nested-tree fetched on expand.
            const arrow = '▶';
            html += `<li style="padding: 3px 0; cursor: pointer; user-select: none;" class="file-tree-item" ${attrDir} title="${key}" onclick="toggleDir('${dirId}', this, '${escapedDirPath}')">${arrow} 📁 ${key}</li>`;
            if (isLazy) {
                html += `<div id="${dirId}" class="nested-tree" data-lazy="1" data-relpath="${escapeAttr(fullPath)}" style="display: none;"></div>`;
            } else {
                html += `<div id="${dirId}" class="nested-tree" style="display: none;">${renderTree(childVal, fullPath, depth + 1)}</div>`;
            }
        } else {
            const clickHandler = `onclick="openWorkspaceFile('${fullPath.replace(/'/g, "\\'")}')"`;
            const attrFile = `data-relpath="${escapeAttr(fullPath)}" data-isdir="0"`;
            html += `<li style="padding: 3px 0; cursor: pointer;" class="file-tree-item" ${attrFile} title="${key}" ${clickHandler}>📄 ${key}</li>`;
        }
    }
    html += '</ul>';
    return html;
}

// Re-render whichever sidebar view is active for the CURRENT workspace folder.
// Used when the folder changes so Source Control tracks the new repo instead of
// staying pinned to the first one. Guarded so we never overwrite the file-tree
// view with git output (or vice-versa).
function refreshActiveSidebar() {
    const activeTab = document.querySelector('.studio-sidebar-tabs .studio-tab.active');
    const target = activeTab ? activeTab.getAttribute('data-target') : 'explorer';
    if (target === 'git') loadGitStatus();
    else loadWorkspaceFiles();
}
window.refreshActiveSidebar = refreshActiveSidebar;

window.promptWorkspace = async function() {
    try {
        const res = await fetch('/api/workspace/pick?type=folder');
        const data = await res.json();
        if (data.path) {
            const dirInput = document.getElementById('dir-input');
            if (dirInput) {
                dirInput.value = data.path;
                localStorage.setItem('last_workspace_dir', data.path);
                idePushRecent(data.path);
                // Refresh the active sidebar view for the NEW folder (file tree
                // OR Source Control), so git status follows the folder change.
                refreshActiveSidebar();
                if (typeof restartTerminal === 'function') {
                    restartTerminal();
                }
            }
        } else if (data.error && data.error !== 'Cancelled') {
            alert('Error picking folder: ' + data.error);
        }
    } catch (e) {
        console.error(e);
    }
};

window.promptWorkspaceFile = async function() {
    try {
        const res = await fetch('/api/workspace/pick?type=file');
        const data = await res.json();
        if (data.path) {
            openWorkspaceFile(data.path);
        } else if (data.error && data.error !== 'Cancelled') {
            alert('Error picking file: ' + data.error);
        }
    } catch (e) {
        console.error(e);
    }
};

// Fetch a lazy directory's immediate children (one level) and render them.
async function lazyLoadDir(dirDiv, relPath) {
    if (dirDiv.dataset.loaded === '1') return;
    const cwd = (document.getElementById('dir-input')?.value || '').replace(/\/$/, '');
    const abs = cwd ? cwd + '/' + relPath : relPath;
    dirDiv.innerHTML = '<div style="padding:4px 14px;color:var(--text-muted);font-size:0.8rem;">Loading…</div>';
    try {
        const data = await (await fetch(`/api/workspace/files?cwd=${encodeURIComponent(abs)}&depth=1`)).json();
        dirDiv.innerHTML = renderTree(data.tree || {}, relPath, 1);
        dirDiv.dataset.loaded = '1';
    } catch (e) {
        dirDiv.innerHTML = '<div style="padding:4px 14px;color:var(--danger);font-size:0.8rem;">Failed to load folder</div>';
    }
}

window.toggleDir = async function(dirId, element, dirPath) {
    const dirDiv = document.getElementById(dirId);
    if (!dirDiv) return;
    if (dirDiv.style.display === 'none') {
        if (dirDiv.dataset.lazy === '1' && dirDiv.dataset.loaded !== '1') {
            await lazyLoadDir(dirDiv, dirPath || dirDiv.dataset.relpath || '');
        }
        dirDiv.style.display = 'block';
        element.innerHTML = element.innerHTML.replace('▶', '▼');
        if (dirPath) window.expandedTreePaths.add(dirPath);
    } else {
        dirDiv.style.display = 'none';
        element.innerHTML = element.innerHTML.replace('▼', '▶');
        if (dirPath) window.expandedTreePaths.delete(dirPath);
    }
};

// After a (re)load, re-open folders the user had expanded (shallow → deep so
// each parent is lazily loaded before its children are looked up).
async function restoreTreeExpansion() {
    const paths = [...window.expandedTreePaths].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const p of paths) {
        const div = document.getElementById(_treePathId(p));
        if (!div) continue;
        if (div.dataset.lazy === '1' && div.dataset.loaded !== '1') await lazyLoadDir(div, p);
        div.style.display = 'block';
        const li = div.previousElementSibling;
        if (li && li.classList.contains('file-tree-item')) li.innerHTML = li.innerHTML.replace('▶', '▼');
    }
}

window.collapseAllDirs = function() {
    document.querySelectorAll('.nested-tree').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.file-tree-item').forEach(el => {
        if (el.innerHTML.includes('▼')) {
            el.innerHTML = el.innerHTML.replace('▼', '▶');
        }
    });
    window.expandedTreePaths.clear();
};

function escapeAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// ==========================================================================
// Fullscreen-safe in-app modals (native prompt()/confirm() misbehave inside
// programmatic browser fullscreen, esp. Safari). Promise-based.
// ==========================================================================
window.showInputModal = function (title, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const ov = document.createElement('div');
        ov.className = 'cortex-modal-overlay';
        ov.innerHTML = `
            <div class="cortex-modal">
                <div class="cortex-modal-title">${title}</div>
                <input class="cortex-modal-input" placeholder="${escapeAttr(opts.placeholder || '')}" />
                <div class="cortex-modal-actions">
                    <button class="cm-cancel">Cancel</button>
                    <button class="cm-ok">${escapeAttr(opts.okLabel || 'OK')}</button>
                </div>
            </div>`;
        document.body.appendChild(ov);
        const input = ov.querySelector('.cortex-modal-input');
        input.value = opts.value || '';
        const done = (v) => { ov.remove(); resolve(v); };
        ov.querySelector('.cm-cancel').onclick = () => done(null);
        ov.querySelector('.cm-ok').onclick = () => done(input.value.trim() || null);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') done(input.value.trim() || null);
            else if (e.key === 'Escape') done(null);
        });
        ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
        setTimeout(() => input.focus(), 30);
    });
};

window.showConfirmModal = function (message, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
        const ov = document.createElement('div');
        ov.className = 'cortex-modal-overlay';
        ov.innerHTML = `
            <div class="cortex-modal">
                <div class="cortex-modal-msg">${message}</div>
                <div class="cortex-modal-actions">
                    <button class="cm-cancel">Cancel</button>
                    <button class="cm-ok ${opts.danger ? 'danger' : ''}">${escapeAttr(opts.okLabel || 'Confirm')}</button>
                </div>
            </div>`;
        document.body.appendChild(ov);
        const done = (v) => { ov.remove(); resolve(v); };
        ov.querySelector('.cm-cancel').onclick = () => done(false);
        ov.querySelector('.cm-ok').onclick = () => done(true);
        ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(false); });
        const onKey = (e) => { if (e.key === 'Escape') { done(false); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
        setTimeout(() => ov.querySelector('.cm-ok').focus(), 30);
    });
};

// ==========================================================================
// File-tree right-click context menu (VS Code-style). Delegated handler on the
// sidebar; reads data-relpath/data-isdir off the clicked item. Every action is
// real; genuinely-external ones (Colab/Share) toast cleanly.
// ==========================================================================
window._fileClipboard = null;   // { op: 'cut'|'copy', abs, name }

function cwdRoot() { return (document.getElementById('dir-input')?.value || '').replace(/\/$/, ''); }
function absOf(rel) { const c = cwdRoot(); return c ? c + '/' + rel : rel; }
function osReveal(abs) {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const isWin = navigator.platform.toLowerCase().includes('win');
    if (isMac) return `open -R "${abs}"`;
    if (isWin) return `explorer /select,"${abs}"`;
    return `xdg-open "${abs.replace(/\/[^/]*$/, '')}"`;
}

async function _post(url, body) {
    try { return await (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json(); }
    catch (e) { return { error: e.message }; }
}

function showFileContextMenu(ev, rel, isDir) {
    ev.preventDefault();
    const old = document.getElementById('file-ctx-menu'); if (old) old.remove();
    const abs = absOf(rel);
    const dir = isDir ? abs : abs.replace(/\/[^/]*$/, '');
    const targetDirRel = isDir ? rel : (rel.includes('/') ? rel.replace(/\/[^/]*$/, '') : '');
    const ext = (rel.split('.').pop() || '').toLowerCase();
    const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext);

    const sep = { sep: true };
    const items = [
        { label: '🧠 Graphify: Build Knowledge Graph', fn: () => ingestPath(isDir ? abs : dir) },
        { label: '💬 Add Folder to Chat', fn: () => ingestPath(isDir ? abs : dir) },
        sep,
        { label: 'New File…', fn: () => createFileIn(targetDirRel) },
        { label: 'New Folder…', fn: () => createFolderIn(targetDirRel) },
        sep,
        { label: 'Reveal in Finder', fn: () => { openTerminalPanel(); injectTerminalCommand(osReveal(abs)); } },
        { label: 'Open in Integrated Terminal', fn: () => { openTerminalPanel(); injectTerminalCommand(`cd "${isDir ? abs : dir}"`); } },
        { label: 'Find in Folder…', fn: () => findInFolder(isDir ? abs : dir) },
        sep,
        { label: 'Cut', fn: () => { window._fileClipboard = { op: 'cut', abs, name: rel.split('/').pop() }; showToast('Cut ' + rel.split('/').pop(), 'info'); } },
        { label: 'Copy', fn: () => { window._fileClipboard = { op: 'copy', abs, name: rel.split('/').pop() }; showToast('Copied ' + rel.split('/').pop(), 'info'); } },
        { label: 'Paste', disabled: !window._fileClipboard, fn: () => pasteInto(isDir ? abs : dir) },
        sep,
        { label: 'Copy Path', fn: () => copyText(abs, 'Path copied') },
        { label: 'Copy Relative Path', fn: () => copyText(rel, 'Relative path copied') },
        sep,
    ];
    if (isImg) items.push({ label: 'Open in Images Preview', fn: () => imagePreview(abs, rel) }, sep);
    items.push(
        { label: 'Run Tests', fn: () => runTestsIn(dir, '') },
        { label: 'Debug Tests', fn: () => runTestsIn(dir, '--pdb') },
        { label: 'Run Tests with Coverage', fn: () => runTestsIn(dir, '--cov') },
        sep,
        { label: 'Rename…', fn: () => renamePath(abs, rel) },
        { label: 'Delete', danger: true, fn: () => deletePath(abs, rel, isDir) },
        sep,
        { label: 'Add as Python Project', fn: () => ingestPath(isDir ? abs : dir) },
        { label: 'Upload to Colab', fn: () => showToast('Colab upload is not configured yet.', 'info') },
        { label: 'Share', fn: () => copyText(abs, 'Path copied (sharing not configured)') }
    );

    const menu = document.createElement('div');
    menu.id = 'file-ctx-menu';
    menu.className = 'file-ctx-menu';
    items.forEach(it => {
        if (it.sep) { const d = document.createElement('div'); d.className = 'fcx-sep'; menu.appendChild(d); return; }
        const row = document.createElement('div');
        row.className = 'fcx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
        row.textContent = it.label;
        if (!it.disabled) row.onclick = () => { menu.remove(); it.fn(); };
        menu.appendChild(row);
    });
    document.body.appendChild(menu);
    const x = Math.min(ev.clientX, window.innerWidth - menu.offsetWidth - 8);
    const y = Math.min(ev.clientY, window.innerHeight - menu.offsetHeight - 8);
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    const dismiss = (e) => { if (menu.contains(e.target)) return; menu.remove(); document.removeEventListener('mousedown', dismiss, true); };
    setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
}

// ---- context-menu action implementations ----
function copyText(text, msg) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => showToast(msg, 'success'))
        .catch(() => { window.prompt('Copy:', text); });
}
function ingestPath(absDir) {
    const projectId = (cwdRoot() || 'default').replace(/[^a-zA-Z0-9-]/g, '_');
    showToast('Building knowledge graph…', 'info');
    _post('/api/process', { directory_path: absDir, project_id: projectId }).then(d => {
        if (d.error) showToast(d.error, 'error');
        else showToast(`Mapped ${(d.nodes || []).length} nodes from ${absDir.split('/').pop()}`, 'success');
    });
}
async function createFileIn(targetDirRel) {
    const name = await showInputModal('New File', { placeholder: 'e.g. notes.md', okLabel: 'Create' }); if (!name) return;
    const rel = targetDirRel ? targetDirRel + '/' + name : name;
    const d = await _post('/api/workspace/file', { path: absOf(rel) });
    if (d.success) { loadWorkspaceFiles(); openWorkspaceFile(rel); } else showToast(d.error || 'Failed', 'error');
}
async function createFolderIn(targetDirRel) {
    const name = await showInputModal('New Folder', { placeholder: 'folder name', okLabel: 'Create' }); if (!name) return;
    const rel = targetDirRel ? targetDirRel + '/' + name : name;
    const d = await _post('/api/workspace/folder', { path: absOf(rel) });
    if (d.success) loadWorkspaceFiles(); else showToast(d.error || 'Failed', 'error');
}
function findInFolder(absDir) {
    const sb = document.querySelector('.studio-sidebar-tabs .studio-tab[data-target="search"], [data-target="search"]');
    if (sb) sb.click();
    setTimeout(() => {
        const inp = document.getElementById('sidebar-search-input');
        if (inp) { inp.focus(); inp.placeholder = 'Search in ' + absDir.split('/').pop() + '…'; }
        window._searchScopeDir = absDir;
    }, 50);
    showToast('Search scoped to ' + absDir.split('/').pop(), 'info');
}
async function pasteInto(absDir) {
    const clip = window._fileClipboard; if (!clip) return;
    const url = clip.op === 'cut' ? '/api/workspace/move' : '/api/workspace/copy';
    const d = await _post(url, { src: clip.abs, dest_dir: absDir });
    if (d.success) { if (clip.op === 'cut') window._fileClipboard = null; loadWorkspaceFiles(); showToast('Pasted ' + clip.name, 'success'); }
    else showToast(d.error || 'Paste failed', 'error');
}
function runTestsIn(absDir, flag) {
    openTerminalPanel();
    const hasPkgJson = false; // python-first; pytest covers the common case
    const cmd = `cd "${absDir}" && pytest ${flag}`.trim();
    injectTerminalCommand(cmd);
}
async function renamePath(abs, rel) {
    const cur = rel.split('/').pop();
    const name = await showInputModal('Rename', { value: cur, okLabel: 'Rename' }); if (!name || name === cur) return;
    const newAbs = abs.replace(/\/[^/]*$/, '/' + name);
    const d = await _post('/api/workspace/rename', { path: abs, new_path: newAbs });
    if (d.success) {
        // reload any open tab for the renamed file
        const tab = (window.openTabs || []).find(t => t.absolutePath === abs);
        if (tab) { closeTab(null, abs); }
        loadWorkspaceFiles();
        showToast('Renamed to ' + name, 'success');
    } else showToast(d.error || 'Rename failed', 'error');
}
async function deletePath(abs, rel, isDir) {
    const ok = await showConfirmModal(`Delete ${isDir ? 'folder' : 'file'} <b>${escapeAttr(rel.split('/').pop())}</b>? This cannot be undone.`, { danger: true, okLabel: 'Delete' });
    if (!ok) return;
    const d = await _post('/api/workspace/delete', { path: abs });
    if (d.success) {
        const tab = (window.openTabs || []).find(t => t.absolutePath === abs);
        if (tab) closeTab(null, abs);
        loadWorkspaceFiles();
        showToast('Deleted ' + rel.split('/').pop(), 'success');
    } else showToast(d.error || 'Delete failed', 'error');
}
function imagePreview(abs, rel) {
    const ov = document.createElement('div');
    ov.className = 'img-preview-overlay';
    ov.onclick = () => ov.remove();
    ov.innerHTML = `<div class="img-preview"><div class="img-preview-name">${rel.split('/').pop()}</div><img src="/api/workspace/raw?path=${encodeURIComponent(abs)}" alt=""></div>`;
    document.body.appendChild(ov);
}

// delegated right-click on the file tree
(function installTreeContextMenu() {
    const root = document.getElementById('studio-sidebar-content');
    if (!root) return;
    root.addEventListener('contextmenu', (e) => {
        const li = e.target.closest && e.target.closest('.file-tree-item');
        if (!li || !li.dataset || li.dataset.relpath === undefined) return;
        showFileContextMenu(e, li.dataset.relpath, li.dataset.isdir === '1');
    });
})();

window.openTabs = window.openTabs || [];
window.activeTabPath = window.activeTabPath || null;

// ===== IDE Welcome screen (shown when no file tab is open) =====
function ideRecentFolders() {
    try { return JSON.parse(localStorage.getItem('cortex_recent_workspaces') || '[]'); }
    catch (e) { return []; }
}
function idePushRecent(path) {
    if (!path) return;
    const list = [path, ...ideRecentFolders().filter(p => p !== path)].slice(0, 6);
    localStorage.setItem('cortex_recent_workspaces', JSON.stringify(list));
}
window.ideOpenRecent = function(path) {
    const dir = document.getElementById('dir-input');
    if (dir) { dir.value = path; localStorage.setItem('last_workspace_dir', path); }
    if (typeof loadWorkspaceFiles === 'function') loadWorkspaceFiles();
    if (typeof refreshActiveSidebar === 'function') refreshActiveSidebar();
    if (typeof restartTerminal === 'function') restartTerminal();
    ideUpdateWelcome();
};
window.ideCloneRepo = async function() {
    const url = (typeof showInputModal === 'function')
        ? await showInputModal('Clone Git Repository', 'Repository URL (https://…)')
        : prompt('Repository URL (https://…)');
    if (!url) return;
    const cwd = document.getElementById('dir-input')?.value || '';
    showToast('Cloning ' + url + ' …', 'info');
    if (typeof injectTerminalCommand === 'function') {
        injectTerminalCommand(`git clone ${url}` + (cwd ? ` "${cwd}/$(basename "${url}" .git)"` : ''));
    } else {
        showToast('Open a terminal to run git clone.', 'info');
    }
};
window.ideUpdateWelcome = function() {
    const welcome = document.getElementById('ide-welcome');
    if (!welcome) return;
    // Overlay the editor area (absolute) — don't hide the monaco row, which
    // collapsed the editor column to 0 width.
    const noTabs = !(window.openTabs && window.openTabs.length);
    welcome.classList.toggle('hidden', !noTabs);
    if (noTabs) {
        const host = document.getElementById('ide-welcome-recent');
        if (host) {
            const recents = ideRecentFolders();
            host.innerHTML = recents.length
                ? recents.map(p => `<a class="ide-welcome-link" title="${p.replace(/"/g,'&quot;')}" onclick="ideOpenRecent('${p.replace(/'/g,"\\'")}')">📁 ${p.split('/').pop() || p}</a>`).join('')
                : '<span class="ide-welcome-empty">No recent folders yet.</span>';
        }
    }
};

window.renderTabs = function() {
    const container = document.getElementById('studio-editor-tabs');
    if (!container) { ideUpdateWelcome(); return; }

    let html = '';
    window.openTabs.forEach(tab => {
        const isActive = tab.absolutePath === window.activeTabPath;
        const basename = tab.relativePath.split('/').pop();
        const safePath = tab.absolutePath.replace(/'/g, "\\'");
        const closeGlyph = tab.dirty ? '●' : '×';
        html += `
            <button class="file-tab ${isActive ? 'active' : ''} ${tab.dirty ? 'dirty' : ''}" onclick="switchToTab('${safePath}')" title="${tab.relativePath}">
                ${basename}
                <span class="tab-close" onclick="closeTab(event, '${safePath}')">${closeGlyph}</span>
            </button>
        `;
    });
    container.innerHTML = html;
    ideUpdateWelcome();
}

window.switchToTab = function(absolutePath) {
    const tab = window.openTabs.find(t => t.absolutePath === absolutePath);
    if (!tab) return;

    // Phase 7: document tabs render in Quill, not Monaco.
    if (tab.kind === 'doc' && window.showDocEditor) {
        window.activeTabPath = absolutePath;
        window.showDocEditor(tab);
        window.renderTabs();
        return;
    }
    // Switching to a code tab — make sure Monaco is visible (hide the doc editor).
    if (window.showCodeEditor) window.showCodeEditor();

    if (tab && window.editor) {
        // Prevent breakpoint ghosting by forcefully wiping active view before switch
        if (window.editor.getModel()) {
            window.editor.deltaDecorations(window.editor.getModel()._breakpointDecorations || [], []);
        }

        window.activeTabPath = absolutePath;
        window.editor.setModel(tab.model);
        updateBreakpointsForModel(tab.model);
        window.renderTabs();
        
        // Redirect terminal to the file's directory
        if (window.terminalWs && window.terminalWs.readyState === WebSocket.OPEN) {
            const lastSlashIndex = absolutePath.lastIndexOf('/');
            if (lastSlashIndex > -1) {
                const fileDir = absolutePath.substring(0, lastSlashIndex);
                // Send Ctrl+U (clear line) then cd command, then Enter
                window.terminalWs.send(JSON.stringify({ type: 'input', data: `\x15cd "${fileDir}"\r` }));
            }
        }
    }
}

window.closeTab = function(event, absolutePath) {
    if (event) event.stopPropagation();
    
    const index = window.openTabs.findIndex(t => t.absolutePath === absolutePath);
    if (index === -1) return;
    
    const tab = window.openTabs[index];
    if (tab.model) tab.model.dispose();
    
    window.openTabs.splice(index, 1);
    
    if (window.activeTabPath === absolutePath) {
        if (window.openTabs.length > 0) {
            switchToTab(window.openTabs[Math.max(0, index - 1)].absolutePath);
        } else {
            window.activeTabPath = null;
            if (window.editor) {
                const emptyModel = monaco.editor.createModel('', 'plaintext');
                window.editor.setModel(emptyModel);
            }
        }
    }
    window.renderTabs();
}

async function openWorkspaceFile(relativePath) {
    const cwd = document.getElementById('dir-input')?.value || "";
    const separator = cwd.endsWith('/') ? '' : '/';
    const absolutePath = cwd ? `${cwd}${separator}${relativePath}` : relativePath;

    // Already open? switchToTab handles both code (Monaco) and doc (Quill) tabs.
    if (window.openTabs.find(t => t.absolutePath === absolutePath)) {
        switchToTab(absolutePath);
        return;
    }

    // Phase 7 polymorphic router: documents (.md/.txt/.docx) open in the Quill
    // rich-text editor instead of Monaco. Falls back to Monaco if richtext.js absent.
    if (window.isDocFile && window.isDocFile(absolutePath) && window.openDocFile) {
        return window.openDocFile(absolutePath, relativePath);
    }

    if (!window.editor) return;
    // Make sure Monaco is the visible surface (not the Quill doc editor) before
    // we set a model — otherwise the file silently opens into a hidden editor.
    if (window.showCodeEditor) try { window.showCodeEditor(); } catch (_) {}
    try {

        const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(absolutePath)}`);
        const data = await res.json();
        if (data.error) {
            console.error(data.error);
            showToast(data.error, 'error');
            return;
        }

        const uri = monaco.Uri.file(absolutePath);
        // Reuse an existing model for this URI — calling createModel twice for the
        // same URI throws "Cannot create two models with the same URI", which was
        // crashing the IDE when a Source-Control file mapped to an already-loaded
        // model that wasn't tracked in openTabs.
        let model = monaco.editor.getModel(uri);
        if (!model) {
            model = monaco.editor.createModel(data.content, undefined, uri);
        } else if (model.getValue() !== data.content) {
            // Refresh stale content only if the editor isn't dirtying it now.
            try { model.setValue(data.content); } catch (_) {}
        }

        const newTab = { absolutePath, relativePath, model: model, dirty: false };
        model.onDidChangeContent(() => {
            if (!newTab.dirty) {
                newTab.dirty = true;
                window.renderTabs && window.renderTabs();
                maybeAutoSave(newTab);
            } else {
                maybeAutoSave(newTab);
            }
        });
        window.openTabs.push(newTab);
        switchToTab(absolutePath);
    } catch (err) {
        console.error('Failed to open file:', err);
        showToast('Could not open ' + relativePath, 'error');
    }
}

// ===== Auto Save (File > Auto Save) =====
window.autoSaveEnabled = window.autoSaveEnabled || false;
let _autoSaveTimers = {};
function maybeAutoSave(tab) {
    if (!window.autoSaveEnabled) return;
    clearTimeout(_autoSaveTimers[tab.absolutePath]);
    _autoSaveTimers[tab.absolutePath] = setTimeout(() => _saveTab(tab, true), 800);
}
window.toggleAutoSave = function() {
    window.autoSaveEnabled = !window.autoSaveEnabled;
    showToast('Auto Save ' + (window.autoSaveEnabled ? 'enabled' : 'disabled'), 'info');
    if (window.autoSaveEnabled) (window.openTabs || []).forEach(t => { if (t.dirty) _saveTab(t, true); });
    return window.autoSaveEnabled;
};

// ===== New untitled file (File > New Text File) =====
let _untitledSeq = 0;
window.newUntitledFile = function() {
    if (!window.editor) { showToast('Open the Studio first.', 'info'); return; }
    _untitledSeq++;
    const name = `Untitled-${_untitledSeq}`;
    const uri = monaco.Uri.parse(`untitled:/${name}`);
    let model;
    try { model = monaco.editor.createModel('', 'plaintext', uri); }
    catch (e) { model = monaco.editor.createModel('', 'plaintext'); }
    const tab = { absolutePath: uri.toString(), relativePath: name, model, dirty: false, untitled: true };
    window.openTabs.push(tab);
    switchToTab(tab.absolutePath);
};

window.createFile = async function() {
    const cwd = document.getElementById('dir-input')?.value || "";
    if (!cwd) { showToast('Open a workspace folder first.', 'info'); return; }
    const name = await showInputModal('New File', { placeholder: 'e.g. src/utils.py', okLabel: 'Create' });
    if (!name) return;
    const absolutePath = cwd.replace(/\/$/, '') + '/' + name;
    try {
        const res = await fetch('/api/workspace/file', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ path: absolutePath })
        });
        const data = await res.json();
        if (data.success) { loadWorkspaceFiles(); openWorkspaceFile(name); }
        else showToast(data.error || 'Failed to create file', 'error');
    } catch (e) { showToast('Failed to create file: ' + e.message, 'error'); }
};

window.createFolder = async function() {
    const cwd = document.getElementById('dir-input')?.value || "";
    if (!cwd) { showToast('Open a workspace folder first.', 'info'); return; }
    const name = await showInputModal('New Folder', { placeholder: 'folder name', okLabel: 'Create' });
    if (!name) return;
    const absolutePath = cwd.replace(/\/$/, '') + '/' + name;
    try {
        const res = await fetch('/api/workspace/folder', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ path: absolutePath })
        });
        const data = await res.json();
        if (data.success) loadWorkspaceFiles();
        else showToast(data.error || 'Failed to create folder', 'error');
    } catch (e) { showToast('Failed to create folder: ' + e.message, 'error'); }
};

// Git Status
function _gitRepoPath() {
    return document.getElementById('dir-input')?.value || "";
}

async function _gitCall(endpoint, body) {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo_path: _gitRepoPath(), ...body })
    });
    return res.json();
}

// Per-file Source Control actions (stage / unstage / discard).
window.gitFileAction = async function(act, file) {
    if (act === 'discard' && !confirm(`Discard all changes to:\n${file}?`)) return;
    const ep = { stage: '/api/git/stage', unstage: '/api/git/unstage', discard: '/api/git/discard' }[act];
    const r = await _gitCall(ep, { filepath: file });
    if (r && r.success === false) showToast(r.message || `git ${act} failed`, 'error');
    loadGitStatus();
};

window.gitInitRepo = async function() {
    const r = await _gitCall('/api/git/init', {});
    showToast(r && r.success ? 'Initialized Git repository.' : (r.message || 'git init failed'),
              r && r.success ? 'success' : 'error');
    loadGitStatus();
};

window.gitCommit = async function() {
    const input = document.getElementById('git-commit-msg');
    const message = (input?.value || '').trim();
    if (!message) { showToast('Enter a commit message first.', 'info'); return; }
    const r = await _gitCall('/api/git/commit', { message });
    if (r && r.success) {
        if (input) input.value = '';
        showToast('Committed.', 'success');
    } else {
        showToast((r && r.message) || 'Nothing to commit', 'error');
    }
    loadGitStatus();
};

// Clicking a file in Source Control opens it in the editor (like the file tree).
// Wrapped so a bad path can never crash the app.
window.gitOpenFile = async function(file) {
    try {
        if (typeof openWorkspaceFile === 'function') {
            await openWorkspaceFile(file);
        }
    } catch (e) {
        console.error('git open file failed', e);
        showToast('Could not open ' + file, 'error');
    }
};

// Optional: show the raw diff for a file in a toast (small affordance).
window.gitShowDiff = async function(file) {
    try {
        const r = await _gitCall('/api/git/diff', { filepath: file });
        showToast((r && r.diff) ? `${file}\n\n${r.diff.slice(0, 600)}` : `${file}: no diff`, 'info');
    } catch (e) {
        showToast('Diff failed for ' + file, 'error');
    }
};

function _gitFileRow(file, act, color, label) {
    const safe = file.replace(/"/g, '&quot;');
    let actions = '';
    if (act === 'staged') {
        actions = `<button class="git-row-btn" title="Unstage" onclick="gitFileAction('unstage','${safe}')">−</button>`;
    } else if (act === 'untracked') {
        actions = `<button class="git-row-btn" title="Stage" onclick="gitFileAction('stage','${safe}')">+</button>`;
    } else {
        actions = `<button class="git-row-btn" title="Discard changes" onclick="gitFileAction('discard','${safe}')">↺</button>
                   <button class="git-row-btn" title="Stage" onclick="gitFileAction('stage','${safe}')">+</button>`;
    }
    const diffBtn = act === 'untracked' ? '' :
        `<button class="git-row-btn" title="View diff" onclick="gitShowDiff('${safe}')">±</button>`;
    return `<li class="git-row" style="display:flex;align-items:center;gap:6px;padding:4px 0;">
        <span class="git-status-flag" style="color:${color};font-weight:bold;">${label}</span>
        <span class="git-file-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;" title="Open ${safe}" onclick="gitOpenFile('${safe}')">${file}</span>
        ${diffBtn}
        ${actions}
    </li>`;
}

async function loadGitStatus() {
    const contentArea = document.getElementById('studio-sidebar-content');
    try {
        const data = await _gitCall('/api/git/status', {});

        if (data.error) {
            if (data.error.includes('not a git repository')) {
                if (contentArea) contentArea.innerHTML = `
                    <div style="padding: 15px; text-align: center;">
                        <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 15px;">The workspace folder is not a Git repository.</p>
                        <button onclick="gitInitRepo()" style="background: rgba(56, 189, 248, 0.15); border: 1px solid var(--accent); color: var(--accent); padding: 8px 16px; border-radius: 4px; cursor: pointer; width: 100%;">Initialize Git Repository</button>
                    </div>`;
            } else if (contentArea) {
                contentArea.innerHTML = `<div style="padding: 10px; color: var(--danger); font-size: 0.8rem;">${data.error}</div>`;
            }
            return;
        }

        const staged = data.staged || [], unstaged = data.unstaged || [], untracked = data.untracked || [];
        let html = '<div style="padding: 10px; font-size: 0.85rem;">';

        // Commit box + refresh
        html += `<div style="display:flex;gap:6px;margin-bottom:12px;">
            <input id="git-commit-msg" placeholder="Commit message" style="flex:1;background:var(--bg-secondary,rgba(255,255,255,0.06));border:1px solid var(--border,rgba(255,255,255,0.12));color:var(--text-primary);border-radius:4px;padding:6px 8px;font-size:0.8rem;">
            <button onclick="gitCommit()" title="Commit staged changes" style="background:var(--accent);color:#04121f;border:none;border-radius:4px;padding:0 10px;cursor:pointer;font-weight:bold;">✓</button>
            <button onclick="loadGitStatus()" title="Refresh" style="background:transparent;border:1px solid var(--border,rgba(255,255,255,0.12));color:var(--text-secondary);border-radius:4px;padding:0 8px;cursor:pointer;">⟳</button>
        </div>`;

        if (staged.length) {
            html += '<h4 style="margin-bottom: 6px; color: var(--text-primary);">Staged Changes</h4><ul style="list-style:none;padding-left:0;margin-bottom:14px;">';
            staged.forEach(f => { html += _gitFileRow(f.replace(/^(\.\.\/)+/, ''), 'staged', 'var(--success)', 'S'); });
            html += '</ul>';
        }
        if (unstaged.length) {
            html += '<h4 style="margin-bottom: 6px; color: var(--text-primary);">Changes</h4><ul style="list-style:none;padding-left:0;margin-bottom:14px;">';
            unstaged.forEach(f => { html += _gitFileRow(f.replace(/^(\.\.\/)+/, ''), 'unstaged', 'var(--warning)', 'M'); });
            html += '</ul>';
        }
        if (untracked.length) {
            html += '<h4 style="margin-bottom: 6px; color: var(--text-primary);">Untracked</h4><ul style="list-style:none;padding-left:0;margin-bottom:14px;">';
            untracked.forEach(f => { html += _gitFileRow(f.replace(/^(\.\.\/)+/, ''), 'untracked', 'var(--accent)', 'U'); });
            html += '</ul>';
        }
        if (!staged.length && !unstaged.length && !untracked.length) {
            html += '<div style="color: var(--text-muted);">No changes detected.</div>';
        }
        html += '</div>';
        if (contentArea) contentArea.innerHTML = html;
    } catch (err) {
        console.error("Git status failed", err);
    }
}

let modelWorker = null;
let currentTokenizeResolvers = {};

async function fetchLocalModels() {
    try {
        const res = await fetch('/api/local-models');
        const data = await res.json();
        const select = document.getElementById('copilot-model-select');
        if (data.status === 'success' && select) {
            select.innerHTML = '';
            data.models.forEach(model => {
                const opt = document.createElement('option');
                opt.value = `local:${model}`;
                opt.textContent = `Local: ${model}`;
                select.appendChild(opt);
            });
            // Add fallback standard api option
            const defaultOpt = document.createElement('option');
            defaultOpt.value = 'gemini/gemini-1.5-pro';
            defaultOpt.textContent = 'Gemini 1.5 Pro (API)';
            select.appendChild(defaultOpt);
            // Preload the chosen model on switch so the first Copilot prompt
            // doesn't pay the cold-load stall (uses the main-chat warmup global).
            if (!select._warmupWired) {
                select._warmupWired = true;
                select.addEventListener('change', () => {
                    if (window.warmupModel) window.warmupModel(select.value);
                });
            }
        }
    } catch (err) {
        console.error('Error fetching local models:', err);
    }
}

function initModelWorker() {
    modelWorker = new Worker('/static/model-worker.js', { type: 'module' });
    
    const indicator = document.getElementById('model-loading-indicator');
    const select = document.getElementById('copilot-model-select');
    
    modelWorker.onmessage = (e) => {
        const { type, status, model, count, isOverload, id, threshold } = e.data;
        
        if (type === 'MODEL_STATUS') {
            if (status === 'loading') {
                indicator.classList.remove('hidden');
                indicator.textContent = 'Loading to VRAM...';
                indicator.style.color = 'var(--text-secondary)';
                select.disabled = true;
            } else if (status === 'ready') {
                indicator.textContent = 'Ready';
                indicator.style.color = 'var(--success)';
                select.disabled = false;
                setTimeout(() => indicator.classList.add('hidden'), 2000);
            } else if (status === 'error') {
                indicator.textContent = 'Error loading';
                indicator.style.color = 'var(--danger)';
                select.disabled = false;
            }
        } else if (type === 'TOKENIZE_RESULT') {
            if (currentTokenizeResolvers[id]) {
                currentTokenizeResolvers[id]({ count, isOverload, threshold });
                delete currentTokenizeResolvers[id];
            }
        }
    };

    // Listen to model select changes
    if (select) {
        select.addEventListener('change', (e) => {
            const modelName = e.target.value;
            modelWorker.postMessage({
                type: 'LOAD_MODEL',
                data: { modelName, contextLimit: 8192 } // Assuming 8k context
            });
        });
    }
}

// Attach (+) and microphone wiring for the Copilot input. Kept separate from
// initModelWorker so these buttons work even when the tokenizer worker
// (an optional enhancement) fails to load.
function initCopilotInputControls() {
    // Handle File Attachment (+) JIT Tokenizer Guard
    const attachBtn = document.getElementById('copilot-attach-btn');
    const fileUpload = document.getElementById('copilot-file-upload');
    const warningText = document.getElementById('jit-tokenizer-warning');

    if (attachBtn && fileUpload) {
        attachBtn.addEventListener('click', () => fileUpload.click());
        
        fileUpload.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            // Images: keep the bytes as base64 for a vision model — NEVER dump
            // raw bytes into the textarea. Show a clean attachment chip instead.
            if (file.type && file.type.startsWith('image/')) {
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
                copilotImageB64 = String(dataUrl).split(',')[1] || null;
                warningText.classList.remove('hidden');
                warningText.style.color = 'var(--success)';
                warningText.textContent = `🖼 Image attached (${file.name}) — will be sent to a vision model.`;
                fileUpload.value = '';
                return;
            }

            const text = await file.text();
            warningText.textContent = 'Analyzing tokens...';
            warningText.classList.remove('hidden');
            warningText.style.color = 'var(--text-secondary)';
            
            const reqId = Date.now().toString();
            
            // Promise wrapper for worker message
            const checkTokens = new Promise(resolve => {
                const timeout = setTimeout(() => resolve({ count: 'unknown', isOverload: false }), 2000);
                if (typeof currentTokenizeResolvers !== 'undefined') {
                    currentTokenizeResolvers[reqId] = (res) => {
                        clearTimeout(timeout);
                        resolve(res);
                    };
                }
                if (typeof modelWorker !== 'undefined' && modelWorker) {
                    modelWorker.postMessage({
                        type: 'TOKENIZE',
                        id: reqId,
                        data: { text, contextLimit: 8192 }
                    });
                } else {
                    resolve({ count: 'unknown', isOverload: false });
                }
            });
            
            const result = await checkTokens;
            
            if (result.isOverload) {
                warningText.style.color = 'var(--danger)';
                warningText.innerHTML = `⚠️ File eceeds safe context window (${result.count} > ${result.threshold} tokens).`;
            } else {
                warningText.style.color = 'var(--success)';
                warningText.textContent = `✅ Attached safe (${result.count} tokens).`;
                setTimeout(() => warningText.classList.add('hidden'), 3000);
                const copilotInput = document.getElementById('copilot-input');
                if (copilotInput) {
                    copilotInput.value += (copilotInput.value ? '\n\n' : '') + `[Attached File: ${file.name}]\n\`\`\`\n${text}\n\`\`\`\n`;
                    copilotInput.style.height = 'auto';
                    copilotInput.style.height = (copilotInput.scrollHeight) + 'px';
                }
            }
            
            fileUpload.value = ''; // Reset
        });
    }

    // Drag-and-drop a file onto the Copilot input → reuse the attach handler
    // (assign to the hidden input and fire its change event).
    const dropZone = document.getElementById('copilot-input');
    if (dropZone && fileUpload) {
        ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over');
        }));
        ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
            e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag-over');
        }));
        dropZone.addEventListener('drop', (e) => {
            const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (!file) return;
            try {
                const dt = new DataTransfer();
                dt.items.add(file);
                fileUpload.files = dt.files;
                fileUpload.dispatchEvent(new Event('change'));
            } catch (_) { /* DataTransfer unsupported — ignore */ }
        });
    }

    // Handle Voice Recording via MediaRecorder API
    const micBtn = document.getElementById('copilot-mic-btn');
    const copilotInput = document.getElementById('copilot-input');
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;

    if (micBtn && navigator.mediaDevices) {
        micBtn.addEventListener('click', async () => {
            if (isRecording) {
                mediaRecorder.stop();
                isRecording = false;
                micBtn.style.color = 'var(--text-primary)';
                micBtn.classList.remove('recording-pulse');
                return;
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) audioChunks.push(e.data);
                };
                
                mediaRecorder.onstop = async () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    audioChunks = [];
                    
                    const formData = new FormData();
                    formData.append('audio', audioBlob, 'voice_memo.webm');
                    
                    copilotInput.placeholder = "Transcribing...";
                    try {
                        const res = await fetch('/api/voice/transcribe', {
                            method: 'POST',
                            body: formData
                        });
                        const data = await res.json();
                        if (data.text) {
                            copilotInput.value += (copilotInput.value ? ' ' : '') + data.text;
                        } else if (data.error) {
                            console.error('Transcription error:', data.error);
                            if (typeof showToast === 'function') showToast('Transcription failed: ' + data.error, 'error');
                        }
                    } catch (err) {
                        console.error('Failed to post audio:', err);
                        if (typeof showToast === 'function') showToast('Voice transcription failed.', 'error');
                    } finally {
                        copilotInput.placeholder = "Ask Copilot...";
                        stream.getTracks().forEach(track => track.stop());
                    }
                };
                
                audioChunks = [];
                mediaRecorder.start();
                isRecording = true;
                micBtn.style.color = 'var(--danger)';
                micBtn.classList.add('recording-pulse');
            } catch (err) {
                console.error("Microphone access denied or unavailable", err);
                if (typeof showToast === 'function') showToast('Microphone access denied or unavailable.', 'error');
            }
        });
    }
}

window.ideEditors = window.ideEditors || [];
window.ideBreakpoints = window.ideBreakpoints || new Set();

let isMonacoInitialized = false;
function initMonacoIfNeeded() {
    if (isMonacoInitialized) {
        window.ideEditors.forEach(e => { if(e) e.layout(); });
        return;
    }
    
    if (window.require) {
        require(['vs/editor/editor.main'], function () {
            window.editor = monaco.editor.create(document.getElementById('monaco-editor-container'), {
                value: '',
                language: 'plaintext',
                theme: 'vs-dark',
                automaticLayout: true,
                minimap: { enabled: true },
                fontSize: 14,
                glyphMargin: true
            });
            window.ideEditors.push(window.editor);
            
            window.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => toggleLeftSidebar());
            window.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ, () => toggleBottomPanel());
            window.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => toggleCopilotSidebar());
            window.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => window.saveActiveFile && window.saveActiveFile());
            window.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => window.saveAllFiles && window.saveAllFiles());
            // VS Code-style debug keys: F5 start/continue debugging, Cmd/Ctrl+F5 run without debugging
            window.editor.addCommand(monaco.KeyCode.F5, () => {
                if (window.debugCommandF5) window.debugCommandF5();
                else if (window.runActiveFile) window.runActiveFile();
            });
            window.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F5, () => window.runActiveFile && window.runActiveFile());
            window.editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F5, () => {
                if (window.dapIsActive && window.dapIsActive()) window.dapStop();
                else if (window.sendToTerminal) window.sendToTerminal('\x03');
            });
            window.editor.addCommand(monaco.KeyCode.F10, () => window.dapStepOver && window.dapStepOver());
            window.editor.addCommand(monaco.KeyCode.F11, () => window.dapStepIn && window.dapStepIn());
            window.editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F11, () => window.dapStepOut && window.dapStepOut());
            window.editor.addCommand(monaco.KeyCode.F9, () => window.toggleBreakpointAtCursor && window.toggleBreakpointAtCursor());
            
            window.editor.onMouseDown(function (e) {
                if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
                    const line = e.target.position.lineNumber;
                    const model = window.editor.getModel();
                    if (!model) return;
                    const uriStr = model.uri.toString();
                    const key = uriStr + ":" + line;
                    
                    if (window.ideBreakpoints.has(key)) {
                        window.ideBreakpoints.delete(key);
                    } else {
                        window.ideBreakpoints.add(key);
                    }
                    updateBreakpointsForModel(model);
                }
            });
            
            isMonacoInitialized = true;
        });
    }
}

function updateBreakpointsForModel(model) {
    if (!model) return;
    const uriStr = model.uri.toString();
    const newDecorations = [];
    if (window.breakpointsDisabled) {
        model._breakpointDecorations = model.deltaDecorations(model._breakpointDecorations || [], []);
        return;
    }
    window.ideBreakpoints.forEach(bp => {
        if (bp.startsWith(uriStr + ":")) {
            // key is "<uri>:<line>" and the uri itself contains colons
            const l = parseInt(bp.slice(uriStr.length + 1), 10);
            if (!l) return;
            newDecorations.push({
                range: new monaco.Range(l, 1, l, 1),
                options: {
                    isWholeLine: false,
                    glyphMarginClassName: 'breakpoint-glyph'
                }
            });
        }
    });
    // Use the model's deltaDecorations to persist them per-tab automatically
    model._breakpointDecorations = model.deltaDecorations(model._breakpointDecorations || [], newDecorations);
}

let isTerminalInitialized = false;

// ==========================================
// Multi-Terminal Layer
// Each session = { id, term, fit, ws, pane, label }
// window.xtermTerminal / window.xtermFitAddon / window.terminalWs always
// alias the *active* session so Run / injectTerminalCommand keep working.
// ==========================================
window.terminalSessions = window.terminalSessions || [];
window.activeTerminalId = window.activeTerminalId || null;
window.termSplitIds = window.termSplitIds || [];
let _termSeq = 0;

function getActiveTermSession() {
    return window.terminalSessions.find(s => s.id === window.activeTerminalId) || null;
}

function ensureTermPanesWrap() {
    const container = document.getElementById('terminal-container');
    if (!container) return null;
    let bar = container.querySelector('.term-tabbar');
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'term-tabbar';
        container.appendChild(bar);
    }
    let wrap = container.querySelector('.term-panes');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'term-panes';
        container.appendChild(wrap);
    }
    return wrap;
}

function renderTermTabs() {
    const container = document.getElementById('terminal-container');
    if (!container) return;
    const bar = container.querySelector('.term-tabbar');
    if (!bar) return;
    bar.innerHTML = '';
    window.terminalSessions.forEach(s => {
        const btn = document.createElement('button');
        btn.className = 'term-tab' + (s.id === window.activeTerminalId ? ' active' : '');
        btn.textContent = s.label;
        btn.title = s.label;
        btn.onclick = () => activateTermSession(s.id);
        const close = document.createElement('span');
        close.className = 'term-tab-close';
        close.textContent = '×';
        close.title = 'Kill Terminal';
        close.onclick = (e) => { e.stopPropagation(); closeTermSession(s.id); };
        btn.appendChild(close);
        bar.appendChild(btn);
    });
    bar.style.display = window.terminalSessions.length > 1 ? 'flex' : 'none';
}

function refreshTermPaneVisibility() {
    const wrap = ensureTermPanesWrap();
    if (!wrap) return;
    const split = window.termSplitIds.length === 2;
    wrap.style.flexDirection = 'row';
    window.terminalSessions.forEach(s => {
        const visible = split ? window.termSplitIds.includes(s.id) : (s.id === window.activeTerminalId);
        s.pane.style.display = visible ? 'block' : 'none';
        s.pane.style.flex = visible && split ? '1' : (visible ? '1 1 100%' : '0');
    });
    setTimeout(() => {
        window.terminalSessions.forEach(s => {
            const visible = split ? window.termSplitIds.includes(s.id) : (s.id === window.activeTerminalId);
            if (visible && s.fit) { try { s.fit.fit(); } catch (e) {} }
        });
    }, 30);
}

// Refit every visible term session to its pane (debounced) — used by the
// ResizeObserver below and the sidebar/panel resizers so terminal text
// reflows instead of being clipped when the layout changes.
let _termFitTimer = null;
window.fitVisibleTerminals = function() {
    if (_termFitTimer) clearTimeout(_termFitTimer);
    _termFitTimer = setTimeout(() => {
        _termFitTimer = null;
        const split = window.termSplitIds.length === 2;
        window.terminalSessions.forEach(s => {
            const visible = split ? window.termSplitIds.includes(s.id) : (s.id === window.activeTerminalId);
            if (visible && s.fit) { try { s.fit.fit(); } catch (e) {} }
        });
    }, 40);
};

(function installTerminalResizeObserver() {
    const container = document.getElementById('terminal-container');
    if (!container || !window.ResizeObserver) {
        window.addEventListener('resize', () => window.fitVisibleTerminals());
        return;
    }
    new ResizeObserver(() => window.fitVisibleTerminals()).observe(container);
})();

function activateTermSession(id) {
    window.termSplitIds = [];
    window.activeTerminalId = id;
    const sess = getActiveTermSession();
    if (sess) {
        window.xtermTerminal = sess.term;
        window.xtermFitAddon = sess.fit;
        window.terminalWs = sess.ws;
    }
    refreshTermPaneVisibility();
    renderTermTabs();
    if (sess) setTimeout(() => sess.term.focus(), 40);
}

function createTermSession() {
    const wrap = ensureTermPanesWrap();
    if (!wrap || !(window.Terminal || typeof Terminal !== 'undefined')) {
        console.error("term Terminal is not available");
        return null;
    }

    const id = ++_termSeq;
    const pane = document.createElement('div');
    pane.className = 'term-pane';
    pane.dataset.termId = String(id);
    wrap.appendChild(pane);

    const term = new (window.Terminal || Terminal)({
        theme: { background: '#000000' },
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        cursorBlink: true
    });

    let fitAddon;
    if (window.FitAddon && window.FitAddon.FitAddon) {
        fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
    }

    term.open(pane);

    // IDE shortcuts inside the terminal
    term.attachCustomKeyEventHandler((e) => {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const modifier = isMac ? e.metaKey : e.ctrlKey;
        if (modifier && e.type === 'keydown' && !e.shiftKey && !e.altKey) {
            if (e.key.toLowerCase() === 'b') { toggleLeftSidebar(); return false; }
            if (e.key.toLowerCase() === 'j') { toggleBottomPanel(); return false; }
            if (e.key.toLowerCase() === 'i') { toggleCopilotSidebar(); return false; }
        }
        return true;
    });

    const session = { id, term, fit: fitAddon, ws: null, pane, label: `Terminal ${id}` };
    window.terminalSessions.push(session);

    connectSessionWs(session);

    pane.addEventListener('mousedown', () => {
        if (window.activeTerminalId !== id && window.termSplitIds.length !== 2) return;
        // keep aliases pointing at whichever split pane the user clicks into
        window.xtermTerminal = session.term;
        window.xtermFitAddon = session.fit;
        window.terminalWs = session.ws;
    });

    return session;
}

function connectSessionWs(session) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    let wsUrl = `${protocol}//${window.location.host}/api/terminal/ws`;
    const cwd = document.getElementById('dir-input')?.value;
    if (cwd) wsUrl += `?cwd=${encodeURIComponent(cwd)}`;

    const ws = new WebSocket(wsUrl);
    session.ws = ws;
    if (session.id === window.activeTerminalId || window.terminalSessions.length === 1) {
        window.terminalWs = ws;
    }

    ws.onopen = () => {
        session.term.write('\r\n*** Connected to local shell ***\r\n');
        ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols || 80, rows: session.term.rows || 24 }));
        ws.send(JSON.stringify({ type: 'input', data: '\r' }));
    };
    ws.onmessage = (event) => { session.term.write(event.data); };
    ws.onerror = () => { session.term.write('\r\n*** Shell connection error ***\r\n'); };
    ws.onclose = (event) => { session.term.write(`\r\n*** Shell disconnected (${event.code}) ***\r\n`); };

    session.term.onData(data => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });
    session.term.onResize(size => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
    });
}

function closeTermSession(id) {
    const idx = window.terminalSessions.findIndex(s => s.id === id);
    if (idx === -1) return;
    const s = window.terminalSessions[idx];
    try { if (s.ws) s.ws.close(); } catch (e) {}
    try { if (s.term) s.term.dispose(); } catch (e) {}
    if (s.pane && s.pane.parentNode) s.pane.parentNode.removeChild(s.pane);
    window.terminalSessions.splice(idx, 1);
    window.termSplitIds = window.termSplitIds.filter(x => x !== id);

    if (window.terminalSessions.length === 0) {
        isTerminalInitialized = false;
        window.activeTerminalId = null;
        window.xtermTerminal = null;
        window.xtermFitAddon = null;
        window.terminalWs = null;
        return;
    }
    if (window.activeTerminalId === id) {
        activateTermSession(window.terminalSessions[Math.max(0, idx - 1)].id);
    } else {
        renderTermTabs();
        refreshTermPaneVisibility();
    }
}

// Spawn an additional terminal (Terminal > New Terminal)
window.newTerminalSession = function() {
    openTerminalPanel();
    const s = createTermSession();
    if (s) activateTermSession(s.id);
    return s;
};

// Split the terminal (Terminal > Split Terminal)
window.splitTerminalSession = function() {
    openTerminalPanel();
    const cur = window.activeTerminalId;
    const s = createTermSession();
    if (!s) return;
    if (cur) {
        window.termSplitIds = [cur, s.id];
        window.activeTerminalId = s.id;
        window.xtermTerminal = s.term;
        window.xtermFitAddon = s.fit;
        window.terminalWs = s.ws;
        refreshTermPaneVisibility();
        renderTermTabs();
        setTimeout(() => s.term.focus(), 40);
    } else {
        activateTermSession(s.id);
    }
};

// Open the bottom panel + focus Terminal tab
window.openTerminalPanel = function() {
    const bottomPanel = document.querySelector('.studio-bottom-panel');
    if (bottomPanel && bottomPanel.classList.contains('collapsed')) {
        toggleBottomPanel();
    }
    const termTab = document.querySelector('.studio-bottom-tabs .studio-tab[data-target="terminal"]');
    if (termTab) termTab.click();
    setTimeout(() => { if (window.xtermFitAddon) window.xtermFitAddon.fit(); }, 60);
};

// Open a detached terminal in a new browser window (Terminal > New Terminal Window)
window.newTerminalWindow = function() {
    const cwd = document.getElementById('dir-input')?.value || '';
    const url = '/static/terminal.html' + (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '');
    window.open(url, 'cortex-terminal-' + Date.now(), 'width=900,height=520');
};

// "⌄" button: pick a terminal session to focus (or spawn new ones)
window.showTerminalSwitcher = function() {
    openTerminalPanel();
    const items = window.terminalSessions.map(s => ({
        label: (s.id === window.activeTerminalId ? '● ' : '') + s.label,
        sublabel: s.ws && s.ws.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
        value: { kind: 'switch', id: s.id }
    }));
    items.push({ label: '+ New Terminal', value: { kind: 'new' } });
    items.push({ label: '↗ New Terminal Window', value: { kind: 'window' } });
    showQuickPick('Switch Terminal', items, (v) => {
        if (v.kind === 'switch') activateTermSession(v.id);
        else if (v.kind === 'new') window.newTerminalSession();
        else if (v.kind === 'window') window.newTerminalWindow();
    });
};

// "..." button: terminal actions menu
window.showTerminalActionsMenu = function() {
    const items = [
        { label: 'Clear Terminal', value: 'clear' },
        { label: 'New Terminal', sublabel: '⌃⇧`', value: 'new' },
        { label: 'Split Terminal', value: 'split' },
        { label: 'New Terminal Window', value: 'window' },
        { label: 'Kill Active Terminal', value: 'kill' },
        { label: 'Restart All Terminals', value: 'restart' },
        { label: 'Run Task...', value: 'task' }
    ];
    showQuickPick('Terminal Actions', items, (v) => {
        const sess = getActiveTermSession();
        if (v === 'clear') { if (sess) sess.term.clear(); }
        else if (v === 'new') window.newTerminalSession();
        else if (v === 'split') window.splitTerminalSession();
        else if (v === 'window') window.newTerminalWindow();
        else if (v === 'kill') { if (sess) closeTermSession(sess.id); else showToast('No active terminal.', 'info'); }
        else if (v === 'restart') { if (typeof restartTerminal === 'function') restartTerminal(); }
        else if (v === 'task') { if (window.runTask) window.runTask(); }
    });
};

function restartTerminal() {
    // Dispose all sessions, then re-create a single primary if in studio
    [...window.terminalSessions].forEach(s => {
        try { if (s.ws) s.ws.close(); } catch (e) {}
        try { if (s.term) s.term.dispose(); } catch (e) {}
    });
    window.terminalSessions = [];
    window.termSplitIds = [];
    window.activeTerminalId = null;
    window.xtermTerminal = null;
    window.xtermFitAddon = null;
    window.terminalWs = null;
    _termSeq = 0;
    isTerminalInitialized = false;
    const container = document.getElementById('terminal-container');
    if (container) container.innerHTML = '';

    if (document.body.classList.contains('studio-active')) {
        setTimeout(() => initTerminalIfNeeded(), 100);
    }
}

function initTerminalIfNeeded() {
    if (isTerminalInitialized && window.terminalSessions.length > 0) return;
    try {
        if (typeof Terminal !== 'undefined' || window.Terminal) {
            const s = createTermSession();
            if (s) {
                activateTermSession(s.id);
                isTerminalInitialized = true;
            }
        } else {
            console.error("window.Terminal is not defined");
        }
    } catch (e) {
        console.error("Terminal Initialization Error: ", e);
        alert("Terminal Error: " + e.message);
    }
}

// ==========================================
// Ports UI Logic
// ==========================================
const refreshPortsBtn = document.getElementById('refresh-ports-btn');
if (refreshPortsBtn) {
    refreshPortsBtn.addEventListener('click', async () => {
        try {
            refreshPortsBtn.textContent = 'Scanning...';
            const res = await fetch('/api/ports');
            const data = await res.json();
            const list = document.getElementById('ports-list');
            list.innerHTML = '';
            
            if (data.ports && data.ports.length > 0) {
                data.ports.forEach(p => {
                    const li = document.createElement('li');
                    li.innerHTML = `
                        <span><strong>${p.port}</strong> <span style="color:var(--text-muted);font-size:0.8rem;">(${p.process} - ${p.pid})</span></span>
                        <a href="http://localhost:${p.port}" target="_blank" class="port-link">Open ↗</a>
                    `;
                    list.appendChild(li);
                });
            } else {
                list.innerHTML = '<li style="color:var(--text-muted);">No active localhost ports found.</li>';
            }
        } catch (e) {
            console.error('Error fetching ports:', e);
        } finally {
            refreshPortsBtn.textContent = 'Refresh Ports';
        }
    });
}

// ==========================================
// Suggest Mode: Inline Diff Application
// ==========================================
async function applySuggestDiff(originalText, modifiedText) {
    if (!window.editor) return;
    
    // Lock the editor to prevent race conditions
    window.editor.updateOptions({ readOnly: true });
    
    try {
        const response = await fetch('/api/suggest-diff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ original_text: originalText, modified_text: modifiedText })
        });
        
        const data = await response.json();
        const patches = data.patches;
        
        // Apply patches (assumes they are sorted in reverse from backend)
        const model = window.editor.getModel();
        
        // Monaco Editor edits require a range and text
        const edits = patches.map(patch => {
            const startLine = patch.start_line;
            const endLine = patch.end_line;
            
            // If it's an insert at line X, startLine == endLine == X, range is empty (col 1 to col 1)
            let range;
            if (patch.tag === 'insert') {
                range = new monaco.Range(startLine, 1, startLine, 1);
            } else {
                // replace or delete
                // endLine is inclusive of the line to replace. We need to replace up to the end of the line.
                const endCol = model.getLineMaxColumn(endLine) || 1;
                range = new monaco.Range(startLine, 1, endLine, endCol);
            }
            
            return {
                range: range,
                text: patch.replacement,
                forceMoveMarkers: true
            };
        });
        
        // Apply all edits in one transaction
        window.editor.executeEdits("suggest-mode", edits);
        
    } catch (err) {
        console.error("Suggest Diff Error:", err);
    } finally {
        // Unlock editor
        window.editor.updateOptions({ readOnly: false });
    }
}

// Search UI Logic
function loadSearchUI() {
    const contentArea = document.getElementById('studio-sidebar-content');
    if (!contentArea) return;
    window._searchScopeDir = null;   // reset to whole-workspace unless Find-in-Folder re-scopes

    contentArea.innerHTML = `
        <div style="padding: 10px; display: flex; flex-direction: column; gap: 10px;">
            <input type="text" id="sidebar-search-input" placeholder="Search" style="width: 100%; background: rgba(255,255,255,0.05); border: 1px solid var(--glass-border); color: white; padding: 6px; border-radius: 4px;">
            <input type="text" id="sidebar-replace-input" placeholder="Replace" style="width: 100%; background: rgba(255,255,255,0.05); border: 1px solid var(--glass-border); color: white; padding: 6px; border-radius: 4px;">
            <div style="display: flex; gap: 5px; justify-content: flex-end;">
                <button id="sidebar-replace-btn" style="background: rgba(255,255,255,0.08); color: var(--text-primary); border: 1px solid var(--glass-border); padding: 6px 12px; border-radius: 4px; cursor: pointer;">Replace All</button>
                <button id="sidebar-search-btn" style="background: var(--accent); color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Search</button>
            </div>
            <div id="sidebar-search-results" style="margin-top: 10px; font-size: 0.85rem; color: var(--text-secondary); max-height: 400px; overflow-y: auto;"></div>
        </div>
    `;

    async function runSidebarSearch() {
        const q = document.getElementById('sidebar-search-input').value;
        if (!q) return;

        const resDiv = document.getElementById('sidebar-search-results');
        resDiv.innerHTML = "Searching...";

        // "Find in Folder" scopes searches to a chosen directory; else whole workspace
        const cwd = window._searchScopeDir || document.getElementById('dir-input')?.value || "";
        try {
            const res = await fetch('/api/workspace/search', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({query: q, repo_path: cwd})
            });
            const data = await res.json();

            if (data.results && data.results.length > 0) {
                resDiv.innerHTML = '';
                data.results.forEach(r => {
                    const row = document.createElement('div');
                    row.style.cssText = "padding: 4px; border-bottom: 1px solid rgba(255,255,255,0.05); cursor: pointer;";
                    const fileDiv = document.createElement('div');
                    fileDiv.style.color = 'var(--accent)';
                    fileDiv.textContent = r.file;
                    const lineDiv = document.createElement('div');
                    lineDiv.style.cssText = "color: #888; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
                    lineDiv.textContent = `Line ${r.line_number}: ${r.match}`;
                    row.appendChild(fileDiv);
                    row.appendChild(lineDiv);
                    row.onclick = () => openWorkspaceFile(r.file);
                    resDiv.appendChild(row);
                });
            } else {
                resDiv.innerHTML = "No results found.";
            }
        } catch (e) {
            resDiv.innerHTML = "Error during search.";
            console.error(e);
        }
    }

    document.getElementById('sidebar-search-btn').addEventListener('click', runSidebarSearch);
    document.getElementById('sidebar-search-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') runSidebarSearch();
    });

    document.getElementById('sidebar-replace-btn').addEventListener('click', async () => {
        const q = document.getElementById('sidebar-search-input').value;
        const replacement = document.getElementById('sidebar-replace-input').value;
        if (!q) { showToast('Enter a search term first.', 'info'); return; }
        if (!confirm(`Replace all occurrences of "${q}" with "${replacement}" across the workspace?`)) return;

        const resDiv = document.getElementById('sidebar-search-results');
        resDiv.innerHTML = "Replacing...";
        const cwd = document.getElementById('dir-input')?.value || "";
        try {
            const res = await fetch('/api/workspace/replace', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({query: q, replacement, repo_path: cwd})
            });
            const data = await res.json();
            if (data.error) {
                resDiv.innerHTML = "Error during replace.";
                showToast(data.error, 'error');
                return;
            }
            resDiv.innerHTML = `Replaced in ${data.count} file(s).`;
            showToast(`Replaced "${q}" in ${data.count} file(s).`, 'success');
            // Reload affected open tabs (keeps unsaved buffers untouched)
            (data.changed || []).forEach(p => handleAgentFileWritten(p));
        } catch (e) {
            resDiv.innerHTML = "Error during replace.";
            console.error(e);
        }
    });
}

// Split Screen Logic
window.toggleSplitScreen = function() {
    const container2 = document.getElementById('monaco-editor-container-2');
    if (!container2) return;
    
    const isHidden = container2.classList.contains('hidden');
    if (isHidden) {
        container2.classList.remove('hidden');
        if (!window.editor2 && window.require) {
            window.editor2 = monaco.editor.create(container2, {
                theme: 'vs-dark',
                automaticLayout: true,
                minimap: { enabled: false },
                fontSize: 14,
                glyphMargin: true
            });
            window.ideEditors.push(window.editor2);
            if (window.editor && window.editor.getModel()) {
                window.editor2.setModel(window.editor.getModel());
            }
        }
    } else {
        container2.classList.add('hidden');
    }
    // Force layout update on all editors
    setTimeout(() => window.ideEditors.forEach(e => { if(e) e.layout(); }), 50);
};

// Run & Debug logic (Terminal Injection)
function injectTerminalCommand(command, { interrupt = true } = {}) {
    // Make sure a terminal exists and is visible
    if (!window.terminalSessions || window.terminalSessions.length === 0) {
        if (typeof openTerminalPanel === 'function') openTerminalPanel();
        if (typeof initTerminalIfNeeded === 'function') initTerminalIfNeeded();
    }
    const bottomPanel = document.querySelector('.studio-bottom-panel');
    if (bottomPanel && bottomPanel.classList.contains('collapsed')) {
        if (typeof toggleBottomPanel === 'function') toggleBottomPanel();
    }

    const send = () => {
        const ws = window.terminalWs;
        if (ws && ws.readyState === WebSocket.OPEN) {
            if (interrupt) {
                // Ctrl+C any running foreground process first, then run the command
                ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
                setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: command + '\n' })), 150);
            } else {
                ws.send(JSON.stringify({ type: 'input', data: command + '\n' }));
            }
        } else {
            // Terminal still spinning up — retry shortly
            setTimeout(send, 400);
        }
    };
    setTimeout(send, 100);
}
window.injectTerminalCommand = injectTerminalCommand;

// Send raw keystrokes to the active terminal (no command framing)
window.sendToTerminal = function(data) {
    const ws = window.terminalWs;
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
    }
};

// ==========================================
// Universal Code Runner (~45 languages)
// Maps a file path to a shell command for its installed toolchain — the same
// model VS Code's Code Runner uses. Compiled languages compile-then-run.
// ==========================================
window.IS_WINDOWS = navigator.platform.toLowerCase().includes('win');

function _buildRunCommand(filePath, mode = 'run') {
    const isWin = window.IS_WINDOWS;
    const dir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    const base = filePath.split(/[\\/]/).pop();          // file.et
    const name = base.replace(/\.[^.]+$/, '');           // file (no et)
    const et = (base.split('.').pop() || '').toLowerCase();
    const q = (s) => `"${s}"`;
    const AND = '&&';                                     // POSIX + pwsh7 + cmd
    const cd = `cd ${q(dir)}`;
    const localBin = isWin ? `.\\${name}.ee` : `./${name}`;

    // Interpreted / single-command languages
    const interp = {
        py:  `python3 ${q(filePath)}`,
        py2: `python2 ${q(filePath)}`,
        js:  `node ${q(filePath)}`,
        mjs: `node ${q(filePath)}`,
        cjs: `node ${q(filePath)}`,
        ts:  `np ts-node ${q(filePath)}`,
        coffee: `coffee ${q(filePath)}`,
        php: `php ${q(filePath)}`,
        pl:  `perl ${q(filePath)}`,
        rb:  `ruby ${q(filePath)}`,
        lua: `lua ${q(filePath)}`,
        groovy: `groovy ${q(filePath)}`,
        ps1: isWin ? `powershell -ExecutionPolicy Bypass -File ${q(filePath)}` : `pwsh ${q(filePath)}`,
        bat: isWin ? `cmd /c ${q(filePath)}` : `cmd ${q(filePath)}`,
        cmd: isWin ? `cmd /c ${q(filePath)}` : `cmd ${q(filePath)}`,
        sh:  `bash ${q(filePath)}`,
        bash: `bash ${q(filePath)}`,
        zsh: `zsh ${q(filePath)}`,
        fs: `dotnet fsi ${q(filePath)}`,
        fsscript: `dotnet fsi ${q(filePath)}`,
        vbs: isWin ? `cscript //Nologo ${q(filePath)}` : `wine cscript ${q(filePath)}`,
        scala: `scala ${q(filePath)}`,
        swift: `swift ${q(filePath)}`,
        jl:  `julia ${q(filePath)}`,
        r:   `Rscript ${q(filePath)}`,
        applescript: `osascript ${q(filePath)}`,
        scpt: `osascript ${q(filePath)}`,
        es: `elixir ${q(filePath)}`,
        clj: `clojure ${q(filePath)}`,
        cljs: `clojure ${q(filePath)}`,
        rkt: `racket ${q(filePath)}`,
        scm: `scheme --quiet < ${q(filePath)}`,
        ss:  `scheme --quiet < ${q(filePath)}`,
        ahk: isWin ? `autohotkey ${q(filePath)}` : `echo "AutoHotkey only runs on Windows"`,
        au3: isWin ? `autoit3 ${q(filePath)}` : `echo "AutoIt only runs on Windows"`,
        dart: `dart run ${q(filePath)}`,
        go:  `go run ${q(filePath)}`,
    };
    if (interp[et]) return interp[et];

    // Compiled languages: compile then execute
    const compiled = {
        c:    `${cd} ${AND} gcc ${q(base)} -o ${q(name)} ${AND} ${localBin}`,
        cpp:  `${cd} ${AND} g++ ${q(base)} -o ${q(name)} ${AND} ${localBin}`,
        cc:   `${cd} ${AND} g++ ${q(base)} -o ${q(name)} ${AND} ${localBin}`,
        c:  `${cd} ${AND} g++ ${q(base)} -o ${q(name)} ${AND} ${localBin}`,
        'c++':`${cd} ${AND} g++ ${q(base)} -o ${q(name)} ${AND} ${localBin}`,
        m:    `${cd} ${AND} gcc ${q(base)} -o ${q(name)} -framework Foundation ${AND} ${localBin}`,   // Objective-C
        rs:   `${cd} ${AND} rustc ${q(base)} -o ${q(name)} ${AND} ${localBin}`,
        java: `${cd} ${AND} javac ${q(base)} ${AND} java ${q(name)}`,
        kt:   `${cd} ${AND} kotlinc ${q(base)} -include-runtime -d ${q(name + '.jar')} ${AND} java -jar ${q(name + '.jar')}`,
        cs:   `${cd} ${AND} dotnet run`,                       // epects a project dir; falls back below
        vb:   `${cd} ${AND} dotnet run`,
        fs:   `${cd} ${AND} dotnet run`,
        hs:   `${cd} ${AND} runghc ${q(base)}`,                // Haskell (no separate binary)
        nim:  `${cd} ${AND} nim compile --run ${q(base)}`,
        cr:   `crystal run ${q(filePath)}`,                    // Crystal
        ml:   `${cd} ${AND} ocaml ${q(base)}`,                 // OCaml
        h:   `${cd} ${AND} hae --run ${q(name)}`,            // Hae (needs class name)
        pas:  `${cd} ${AND} fpc ${q(base)} ${AND} ${localBin}`,// Pascal
        pp:   `${cd} ${AND} fpc ${q(base)} ${AND} ${localBin}`,
    };
    if (compiled[et]) return compiled[et];

    return null;
}

window.getRunCommandForPath = _buildRunCommand;

window.runFileByPath = function(filePath) {
    if (!filePath) { showToast('No file to run.', 'error'); return; }
    saveActiveFile(true);  // silent save so we run the latest buffer
    const cmd = _buildRunCommand(filePath, 'run');
    if (!cmd) {
        const et = (filePath.split('.').pop() || '').toLowerCase();
        showToast(`No runner configured for ".${et}" files.`, 'error');
        return;
    }
    injectTerminalCommand(cmd);
};

window.runActiveFile = function() {
    if (!window.activeTabPath) { showToast('No active file to run.', 'error'); return; }
    window.runFileByPath(window.activeTabPath);
};

// Run the current selection (or whole file) line-by-line in the active terminal.
// Mirrors VS Code's "Run Selected Text in Active Terminal".
window.runSelectedText = function() {
    if (!window.editor) { showToast('Editor not ready.', 'error'); return; }
    const model = window.editor.getModel();
    const sel = window.editor.getSelection();
    let text = '';
    if (sel && !sel.isEmpty()) {
        text = model.getValueInRange(sel);
    } else {
        text = model.getValue();
    }
    if (!text.trim()) { showToast('Nothing selected to run.', 'error'); return; }
    if (typeof openTerminalPanel === 'function') openTerminalPanel();
    setTimeout(() => window.sendToTerminal(text.replace(/\r?\n/g, '\n') + '\n'), 200);
};

window.debugActiveFile = function() {
    if (!window.activeTabPath) { showToast('No active file to debug.', 'error'); return; }
    // Visual DAP debugging (debugger.js); falls back to the terminal
    // CLI debuggers below when no adapter exists for the language.
    if (window.dapStartSession) return window.dapStartSession();
    window.debugActiveFileFallback();
};

// Terminal CLI debugger fallback (pdb / node inspect)
window.debugActiveFileFallback = function() {
    if (!window.activeTabPath) { showToast('No active file to debug.', 'error'); return; }
    saveActiveFile(true);
    const ext = window.activeTabPath.split('.').pop().toLowerCase();
    let cmd = "";
    if (ext === 'py') cmd = `python3 -m pdb "${window.activeTabPath}"`;
    else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') cmd = `node inspect "${window.activeTabPath}"`;
    else { showToast(`Interactive debug not available for ".${ext}". Running instead.`, 'info'); return window.runActiveFile(); }
    injectTerminalCommand(cmd);
};

// ==========================================
// File persistence (Save / Save All)
// ==========================================
async function _saveTab(tab, silent) {
    if (!tab) return false;
    // Phase 7: document tabs persist via the Quill->markdown path in richtext.js
    if (tab.kind === 'doc' && window.saveDocTab) return window.saveDocTab(tab, silent);
    if (!tab.model) return false;
    try {
        const res = await fetch('/api/workspace/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: tab.absolutePath, content: tab.model.getValue() })
        });
        const data = await res.json();
        if (data.success) {
            tab.dirty = false;
            window.renderTabs && window.renderTabs();
            if (!silent) showToast(`Saved ${tab.relativePath.split('/').pop()}`, 'success');
            return true;
        }
        showToast(data.error || 'Save failed', 'error');
        return false;
    } catch (e) {
        showToast('Save failed: ' + e.message, 'error');
        return false;
    }
}

window.saveActiveFile = function(silent) {
    const tab = (window.openTabs || []).find(t => t.absolutePath === window.activeTabPath);
    if (!tab) { if (!silent) showToast('No file to save.', 'info'); return; }
    if (tab.untitled) { if (silent) return; return window.saveActiveFileAs(); }
    return _saveTab(tab, silent);
};

window.saveActiveFileAs = async function() {
    const tab = (window.openTabs || []).find(t => t.absolutePath === window.activeTabPath);
    if (!tab) { showToast('No file to save.', 'info'); return; }
    const cwd = (document.getElementById('dir-input')?.value || '').replace(/\/+$/, '');
    const suggested = tab.untitled ? (cwd ? cwd + '/' + tab.relativePath + '.tt' : tab.relativePath + '.tt') : tab.absolutePath;
    const target = prompt('Save As (full path):', suggested);
    if (!target) return;
    try {
        const res = await fetch('/api/workspace/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: target, content: tab.model.getValue() })
        });
        const data = await res.json();
        if (!data.success) { showToast(data.error || 'Save failed', 'error'); return; }
        // Drop the old (untitled) tab, then reopen the freshly written file.
        closeTab(null, tab.absolutePath);
        if (cwd && target.startsWith(cwd + '/')) {
            await openWorkspaceFile(target.slice(cwd.length + 1));   // relative to workspace
        } else {
            await openAbsoluteFile(target);                          // outside workspace
        }
        if (typeof loadWorkspaceFiles === 'function') loadWorkspaceFiles();
        showToast('Saved ' + target.split('/').pop(), 'success');
    } catch (e) { showToast('Save failed: ' + e.message, 'error'); }
};

// Open a file by absolute path (used when the path is outside the workspace root).
async function openAbsoluteFile(absolutePath) {
    if (!window.editor) return;
    if (window.openTabs.find(t => t.absolutePath === absolutePath)) { switchToTab(absolutePath); return; }
    const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(absolutePath)}`);
    const data = await res.json();
    if (data.error) { showToast(data.error, 'error'); return; }
    const relativePath = absolutePath.split('/').pop();
    const uri = monaco.Uri.file(absolutePath);
    let model;
    try { model = monaco.editor.createModel(data.content, undefined, uri); }
    catch (e) { model = monaco.editor.getModel(uri) || monaco.editor.createModel(data.content); }
    const newTab = { absolutePath, relativePath, model, dirty: false };
    model.onDidChangeContent(() => {
        if (!newTab.dirty) { newTab.dirty = true; window.renderTabs && window.renderTabs(); }
        maybeAutoSave(newTab);
    });
    window.openTabs.push(newTab);
    switchToTab(absolutePath);
}

window.saveAllFiles = async function() {
    const tabs = window.openTabs || [];
    if (tabs.length === 0) { showToast('No open files.', 'info'); return; }
    let n = 0;
    for (const t of tabs) { if (await _saveTab(t, true)) n++; }
    showToast(`Saved ${n} file${n === 1 ? '' : 's'}.`, 'success');
};

window.revertActiveFile = async function() {
    const tab = (window.openTabs || []).find(t => t.absolutePath === window.activeTabPath);
    if (!tab) return;
    try {
        const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(tab.absolutePath)}`);
        const data = await res.json();
        if (data.content !== undefined) {
            tab.model.setValue(data.content);
            tab.dirty = false;
            window.renderTabs && window.renderTabs();
            showToast('Reverted to saved version.', 'info');
        }
    } catch (e) { showToast('Revert failed.', 'error'); }
};

// ==========================================
// Lightweight toast notifications
// ==========================================
window.showToast = function(message, type = 'info') {
    let host = document.getElementById('cortex-toast-host');
    if (!host) {
        host = document.createElement('div');
        host.id = 'cortex-toast-host';
        document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = 'cortex-toast ' + type;
    t.textContent = message;
    host.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.remove(), 250);
    }, 3200);
};

// ==========================================
// Breakpoint controls (Run menu)
// ==========================================
window.breakpointsDisabled = window.breakpointsDisabled || false;

window.toggleBreakpointAtCursor = function() {
    if (!window.editor) return;
    const model = window.editor.getModel();
    const pos = window.editor.getPosition();
    if (!model || !pos) return;
    const key = model.uri.toString() + ':' + pos.lineNumber;
    if (window.ideBreakpoints.has(key)) window.ideBreakpoints.delete(key);
    else window.ideBreakpoints.add(key);
    if (window.breakpointsDisabled) window.breakpointsDisabled = false;
    updateBreakpointsForModel(model);
};

function _redrawAllBreakpoints() {
    (window.openTabs || []).forEach(t => { if (t.model) updateBreakpointsForModel(t.model); });
    if (window.editor && window.editor.getModel()) updateBreakpointsForModel(window.editor.getModel());
}

window.removeAllBreakpoints = function() {
    window.ideBreakpoints.clear();
    _redrawAllBreakpoints();
    showToast('All breakpoints removed.', 'info');
};

window.setAllBreakpointsEnabled = function(enabled) {
    window.breakpointsDisabled = !enabled;
    _redrawAllBreakpoints();
    showToast('All breakpoints ' + (enabled ? 'enabled' : 'disabled') + '.', 'info');
};

// ==========================================
// Task System (Terminal menu)
// Tasks live in <workspace>/.cortex/tasks.json:
//   { "tasks": [ { "label": "build", "command": "make", "group": "build" } ] }
// ==========================================
window._runningTasks = window._runningTasks || [];
window._lastTask = window._lastTask || null;

function _tasksPath() {
    const cwd = document.getElementById('dir-input')?.value || '';
    if (!cwd) return null;
    return cwd.replace(/\/+$/, '') + '/.cortex/tasks.json';
}

async function loadTasks() {
    const path = _tasksPath();
    if (!path) return [];
    try {
        const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        if (data.content) {
            const parsed = JSON.parse(data.content);
            return Array.isArray(parsed.tasks) ? parsed.tasks : [];
        }
    } catch (e) { /* no tasks file yet */ }
    return [];
}

async function saveTasks(tasks) {
    const path = _tasksPath();
    if (!path) { showToast('Open a workspace folder first.', 'error'); return false; }
    const res = await fetch('/api/workspace/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: JSON.stringify({ tasks }, null, 2) })
    });
    const data = await res.json();
    return !!data.success;
}

function _execTask(task) {
    if (!task || !task.command) return;
    window._lastTask = task;
    window._runningTasks = window._runningTasks.filter(t => t.label !== task.label);
    window._runningTasks.push({ label: task.label, startedAt: Date.now() });
    if (typeof openTerminalPanel === 'function') openTerminalPanel();
    injectTerminalCommand(task.command);
    showToast(`Running task: ${task.label}`, 'info');
}

window.runTask = async function() {
    const tasks = await loadTasks();
    if (tasks.length === 0) {
        if (confirm('No tasks configured. Create .cortex/tasks.json now?')) window.configureTasks();
        return;
    }
    showQuickPick('Select a task to run', tasks.map(t => ({ label: t.label, sublabel: t.command, value: t })), (t) => _execTask(t));
};

window.runBuildTask = async function() {
    const tasks = await loadTasks();
    const build = tasks.find(t => t.group === 'build' && t.isDefault) || tasks.find(t => t.group === 'build');
    if (build) return _execTask(build);
    if (tasks.length > 0) return window.runTask();
    if (confirm('No build task configured. Create .cortex/tasks.json now?')) window.configureTasks();
};

window.showRunningTasks = function() {
    if (window._runningTasks.length === 0) { showToast('No running tasks.', 'info'); return; }
    showQuickPick('Running tasks', window._runningTasks.map(t => ({ label: t.label, sublabel: 'started ' + new Date(t.startedAt).toLocaleTimeString(), value: t })), () => {});
};

window.restartRunningTask = function() {
    if (!window._lastTask) { showToast('No task to restart.', 'info'); return; }
    window.sendToTerminal('\x03');
    setTimeout(() => _execTask(window._lastTask), 200);
};

window.terminateTask = function() {
    window.sendToTerminal('\x03');
    window._runningTasks = [];
    showToast('Sent terminate (Ctrl+C) to terminal.', 'info');
};

window.configureTasks = async function() {
    const cwd = document.getElementById('dir-input')?.value || '';
    if (!cwd) { showToast('Open a workspace folder first.', 'error'); return; }
    let tasks = await loadTasks();
    if (tasks.length === 0) {
        tasks = [
            { label: 'build', command: 'echo "configure your build command"', group: 'build', isDefault: true },
            { label: 'test', command: 'echo "configure your test command"', group: 'test' }
        ];
        await saveTasks(tasks);
    }
    const path = _tasksPath();
    const rel = path.startsWith(cwd) ? path.slice(cwd.length).replace(/^\/+/, '') : path;
    if (typeof loadWorkspaceFiles === 'function') loadWorkspaceFiles();
    openWorkspaceFile(rel);
    showToast('Edit .cortex/tasks.json to configure tasks.', 'info');
};

window.configureDefaultBuildTask = async function() {
    const tasks = await loadTasks();
    const buildTasks = tasks.filter(t => t.group === 'build');
    if (buildTasks.length === 0) { return window.configureTasks(); }
    showQuickPick('Set default build task', buildTasks.map(t => ({ label: t.label, sublabel: t.command, value: t })), async (chosen) => {
        tasks.forEach(t => { if (t.group === 'build') t.isDefault = (t.label === chosen.label); });
        if (await saveTasks(tasks)) showToast(`Default build task: ${chosen.label}`, 'success');
    });
};

// ==========================================
// Generic Quick Pick (command-palette-style chooser)
// ==========================================
window.showQuickPick = function(title, items, onPick) {
    closeQuickPick();
    const overlay = document.createElement('div');
    overlay.id = 'cortex-quickpick-overlay';
    overlay.className = 'cortex-quickpick-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) closeQuickPick(); };

    const box = document.createElement('div');
    box.className = 'cortex-quickpick';
    const input = document.createElement('input');
    input.className = 'cortex-quickpick-input';
    input.placeholder = title || 'Select...';
    const list = document.createElement('div');
    list.className = 'cortex-quickpick-list';
    box.appendChild(input);
    box.appendChild(list);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let filtered = items.slice();
    let active = 0;
    function render() {
        list.innerHTML = '';
        filtered.forEach((it, i) => {
            const row = document.createElement('div');
            row.className = 'cortex-quickpick-item' + (i === active ? ' active' : '');
            row.innerHTML = `<span class="qp-label">${it.label}</span>` + (it.sublabel ? `<span class="qp-sub">${it.sublabel}</span>` : '');
            row.onclick = () => { closeQuickPick(); onPick(it.value, it); };
            list.appendChild(row);
        });
    }
    input.oninput = () => {
        const q = input.value.toLowerCase();
        filtered = items.filter(it => (it.label + ' ' + (it.sublabel || '')).toLowerCase().includes(q));
        active = 0;
        render();
    };
    input.onkeydown = (e) => {
        if (e.key === 'ArrowDown') { active = Math.min(active + 1, filtered.length - 1); render(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
        else if (e.key === 'Enter') { if (filtered[active]) { const it = filtered[active]; closeQuickPick(); onPick(it.value, it); } }
        else if (e.key === 'Escape') { closeQuickPick(); }
    };
    render();
    setTimeout(() => input.focus(), 20);
};

function closeQuickPick() {
    const e = document.getElementById('cortex-quickpick-overlay');
    if (e) e.remove();
}

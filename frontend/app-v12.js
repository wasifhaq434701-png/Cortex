// ==========================================
// 0. Initialization & Model Discovery
// ==========================================
async function discoverLocalModels() {
    const providerSelect = document.getElementById('provider-select') || UI.providerSelect;
    if (!providerSelect) return;

    try {
        const response = await fetch('/api/local-models');
        const data = await response.json();

        if (data.status === 'success' && data.models.length > 0) {
            const localOptions = providerSelect.querySelectorAll('option[value^="local:"]');
            localOptions.forEach(opt => opt.remove());

            // Find or create the Local Models optgroup
            let localGroup = providerSelect.querySelector('optgroup[label="Local Models"]');
            if (!localGroup) {
                localGroup = document.createElement('optgroup');
                localGroup.label = 'Local Models';
                providerSelect.prepend(localGroup);
            } else {
                localGroup.innerHTML = '';
            }

            // Find or create the MLX Models optgroup
            let mlGroup = providerSelect.querySelector('optgroup[label="MLX (Apple Silicon)"]');
            if (!mlGroup) {
                mlGroup = document.createElement('optgroup');
                mlGroup.label = 'MLX (Apple Silicon)';
                providerSelect.appendChild(mlGroup);
            }
            
            // Keep the custom options if they exist
            const customMl = mlGroup.querySelector('option[value="local-ml:custom"]');
            mlGroup.innerHTML = '';
            
            data.models.forEach(modelName => {
                const option = document.createElement('option');
                const isMl = modelName.toLowerCase().includes('ml');
                
                option.value = `local:${modelName}`;
                option.textContent = isMl ? `MLX: ${modelName}` : `Local: ${modelName}`;

                if (modelName.toLowerCase().includes('qwen') && isMl) {
                    option.selected = true;
                }

                if (isMl) {
                    mlGroup.appendChild(option);
                } else {
                    localGroup.appendChild(option);
                }
            });
            
            if (customMl) mlGroup.appendChild(customMl);
            
            console.log(`Discovered ${data.models.length} local models.`);
        } else {
            console.warn("No local models found or Ollama is offline.");
        }
    } catch (error) {
        console.error("Local model auto-discovery failed:", error);
    }
}

// Initialize Mermaid.js
mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
        primaryColor: '#38bdf8',
        primaryTextColor: '#f8fafc',
        primaryBorderColor: '#a855f7',
        lineColor: '#94a3b8',
        sectionBkgColor: '#0f172a',
        altSectionBkgColor: '#1e293b',
        gridColor: '#334155',
        secondaryColor: '#a855f7',
        tertiaryColor: '#ec4899'
    },
    securityLevel: 'loose',
    fontFamily: 'Inter, sans-serif'
});

document.addEventListener('DOMContentLoaded', () => {
    discoverLocalModels();
});

// ==========================================
// 1. Configuration & State
// ==========================================
marked.setOptions({
    highlight: function (code, lang) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        return hljs.highlight(code, { language }).value;
    }
});

const COLORS = ['#38bdf8', '#a855f7', '#ec4899', '#10b981', '#f59e0b', '#ef4444'];
let MindGraph = null;
let currentGraphData = null;

function getClusterColor(clusterId) {
    return COLORS[(clusterId || 0) % COLORS.length];
}

// Threaded Session Memory
let chatSessions = JSON.parse(localStorage.getItem('mp_sessions')) || [];
let currentSessionId = null;

// Project Workspaces Memory
let projects = JSON.parse(localStorage.getItem('mp_projects')) || [];
let currentProjectId = null;

// Chart Instance Registry (Ghost Canvas Fix)
window.chartRegistry = {};
window.pendingCharts = [];

// Mermaid Instance Counter
let mermaidCounter = 0;

// Generation control
let activeAbortController = null;

// Uploaded file context — stores extracted text from the most recently uploaded file
// so the very next query can use it directly without relying on vector search
let lastUploadedContent = null;
let lastUploadedFilename = null;
let lastUploadedImageB64 = null;  // base64 of an uploaded image, for vision models

const UI = {
    btn: document.getElementById('process-btn'),
    input: document.getElementById('dir-input'),
    searchWrapper: document.getElementById('search-wrapper'),
    searchInput: document.getElementById('semantic-search'),
    searchBtn: document.getElementById('search-btn'),
    canvas: document.getElementById('3d-canvas'),
    providerSelect: document.getElementById('ai-provider-select'),
    keyInput: document.getElementById('api-key-input'),
    customMlInput: document.getElementById('custom-ml-input'),
    customCloudInput: document.getElementById('custom-cloud-input'),

    chatInterface: document.getElementById('chat-interface'),
    chatInput: document.getElementById('chat-input'),
    chatSendBtn: document.getElementById('chat-send-btn'),
    chatOutput: document.getElementById('chat-output'),

    // Welcome State
    welcomeState: document.getElementById('welcome-state'),

    // Sidebar
    leftPanel: document.getElementById('left-panel'),
    sidebarToggle: document.getElementById('sidebar-toggle-btn'),
    newChatBtn: document.getElementById('new-chat-btn'),

    // Projects
    newProjectBtn: document.getElementById('new-project-btn'),
    projectList: document.getElementById('project-list'),

    // Generation Buttons
    genWebBtn: document.getElementById('gen-web-btn'),
    genPdfBtn: document.getElementById('gen-pdf-btn'),
    genPptBtn: document.getElementById('gen-ppt-btn'),
    genCsvBtn: document.getElementById('gen-csv-btn'),
    genVisualizeBtn: document.getElementById('gen-visualize-btn'),
    genJsonBtn: document.getElementById('gen-json-btn'),
    pptThemeSelect: document.getElementById('ppt-theme-select'),
    pptSlideCount: document.getElementById('ppt-slide-count'),
    pptOptionsRow: document.getElementById('ppt-options-row'),
    pptCustomTheme: document.getElementById('ppt-custom-theme'),

    // Theme Toggle
    themeToggleBtn: document.getElementById('theme-toggle-btn'),
    themeLabel: document.getElementById('theme-label-text'),

    // Settings Modal
    settingsBtn: document.getElementById('settings-btn'),
    settingsModal: document.getElementById('settings-modal'),
    settingsCloseBtn: document.getElementById('settings-close-btn'),

    // View Mode
    viewModeBtn: document.getElementById('view-mode-btn'),
    viewModeIcon: document.getElementById('view-mode-icon'),
    viewModeLabel: document.getElementById('view-mode-label'),
    workspaceContainer: document.querySelector('.workspace-container'),
};

// ==========================================
// 2. Collapsible Sidebar
// ==========================================
function initSidebar() {
    const collapsed = localStorage.getItem('mp_sidebar_collapsed') === 'true';
    if (collapsed) {
        UI.leftPanel.classList.add('collapsed');
        UI.sidebarToggle.classList.add('active');
    }
}

function toggleSidebar() {
    const isCollapsed = UI.leftPanel.classList.toggle('collapsed');
    UI.sidebarToggle.classList.toggle('active', isCollapsed);
    localStorage.setItem('mp_sidebar_collapsed', isCollapsed);
}

UI.sidebarToggle.addEventListener('click', toggleSidebar);
initSidebar();

// ==========================================
// 2b. Theme Switching (Dark / Light)
// ==========================================
function initTheme() {
    const savedTheme = localStorage.getItem('mp_theme') || 'dark';
    applyTheme(savedTheme);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    
    if (UI.themeLabel) {
        UI.themeLabel.textContent = theme === 'light' ? 'Light Mode' : 'Dark Mode';
    }
    if (UI.themeToggleBtn) {
        const iconSpan = UI.themeToggleBtn.querySelector('.spm-icon');
        if (iconSpan) iconSpan.textContent = theme === 'light' ? '☀️' : '🌙';
    }
    
    // Update 3D graph background if it exists
    if (MindGraph) {
        MindGraph.backgroundColor(theme === 'light' ? '#f5f5f5' : '#0a0a0a');
    }
    
    localStorage.setItem('mp_theme', theme);
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(newTheme);
}

if (UI.themeToggleBtn) {
    UI.themeToggleBtn.addEventListener('click', toggleTheme);
}
initTheme();

// ==========================================
// 2c. Settings Modal
// ==========================================
function toggleSettings() {
    console.log('[Settings] Toggling settings popup');
    const modal = document.getElementById('settings-modal');
    if (modal) {
        if (modal.classList.contains('hidden')) {
            modal.classList.remove('hidden');
        } else {
            modal.classList.add('hidden');
        }
    }
}

function closeSettings() {
    console.log('[Settings] Closing settings popup');
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.add('hidden');
}

if (UI.settingsBtn) {
    UI.settingsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleSettings();
    });
}
if (UI.settingsCloseBtn) {
    UI.settingsCloseBtn.addEventListener('click', closeSettings);
}
// Close on overlay click (outside modal)
document.addEventListener('click', (e) => {
    if (!UI.settingsModal || UI.settingsModal.classList.contains('hidden')) return;
    
    // If click is outside the popup content AND not on the settings button
    const popupContent = UI.settingsModal.querySelector('.settings-modal-content');
    if (popupContent && !popupContent.contains(e.target) && e.target !== UI.settingsBtn && !UI.settingsBtn.contains(e.target)) {
        closeSettings();
    }
});
// Close on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('settings-modal');
        if (modal && !modal.classList.contains('hidden')) {
            closeSettings();
        }
    }
});

// ==========================================
// 2d. View Mode System (3-state cycling)
// ==========================================
const VIEW_MODES = [
    { id: 'immersive', icon: '✦', label: 'Immersive' },
    { id: 'graph-only', icon: '🧠', label: 'Graph Only' },
    { id: 'chat-only', icon: '💬', label: 'Chat Only' },
];

let currentViewModeIndex = 0;

function initViewMode() {
    const saved = localStorage.getItem('mp_view_mode') || 'immersive';
    const id = VIEW_MODES.findIndex(m => m.id === saved);
    currentViewModeIndex = id >= 0 ? id : 0;
    applyViewMode(VIEW_MODES[currentViewModeIndex]);
}

function applyViewMode(mode) {
    const canvasEl = document.getElementById('3d-canvas');
    const overlayEl = document.querySelector('.ambient-overlay');
    const chatMain = document.getElementById('chat-interface');

    // Remove all view mode classes from workspace container
    VIEW_MODES.forEach(m => {
        UI.workspaceContainer.classList.remove(`view-${m.id}`);
    });
    // Apply new view mode class to both container and body
    UI.workspaceContainer.classList.add(`view-${mode.id}`);
    document.body.classList.add(`view-${mode.id}`);

    // Direct JS manipulation of elements outside workspace-container
    if (mode.id === 'chat-only') {
        if (canvasEl) { canvasEl.style.opacity = '0'; canvasEl.style.pointerEvents = 'none'; }
        if (overlayEl) { overlayEl.style.opacity = '1'; }
        if (chatMain) { chatMain.style.opacity = '1'; chatMain.style.pointerEvents = 'auto'; chatMain.style.transform = 'none'; }
    } else if (mode.id === 'graph-only') {
        if (canvasEl) { canvasEl.style.opacity = '1'; canvasEl.style.pointerEvents = 'auto'; }
        if (overlayEl) { overlayEl.style.opacity = '0.3'; }
        if (chatMain) { chatMain.style.opacity = '0'; chatMain.style.pointerEvents = 'none'; chatMain.style.transform = 'translateY(20px)'; }
    } else {
        // Immersive mode (default)
        if (canvasEl) { canvasEl.style.opacity = '1'; canvasEl.style.pointerEvents = 'auto'; }
        if (overlayEl) { overlayEl.style.opacity = '1'; }
        if (chatMain) { chatMain.style.opacity = '1'; chatMain.style.pointerEvents = 'auto'; chatMain.style.transform = 'none'; }
    }

    // Update header button
    if (UI.viewModeIcon) UI.viewModeIcon.textContent = mode.icon;
    if (UI.viewModeLabel) UI.viewModeLabel.textContent = mode.label;

    // Update settings modal buttons
    document.querySelectorAll('.settings-view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === mode.id);
    });

    localStorage.setItem('mp_view_mode', mode.id);

    // Resize 3D graph if it exists (fixes rendering issues on mode switch)
    if (MindGraph) {
        setTimeout(() => MindGraph.renderer().setSize(window.innerWidth, window.innerHeight), 100);
    }
}

function cycleViewMode() {
    currentViewModeIndex = (currentViewModeIndex + 1) % VIEW_MODES.length;
    applyViewMode(VIEW_MODES[currentViewModeIndex]);
}

function setViewMode(modeId) {
    const id = VIEW_MODES.findIndex(m => m.id === modeId);
    if (id >= 0) {
        currentViewModeIndex = id;
        applyViewMode(VIEW_MODES[id]);
    }
}

// Header button cycles through modes
if (UI.viewModeBtn) {
    UI.viewModeBtn.addEventListener('click', cycleViewMode);
}

// Settings modal view buttons set mode directly
document.querySelectorAll('.settings-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        if (mode) setViewMode(mode);
    });
});

initViewMode();

// ==========================================
// 3. Dynamic Chart & Mermaid Rendering Engine
// ==========================================
function formatChatMessage(text) {
    let chartJsonRaw = null;
    let mermaidCode = null;
    let textBefore = text;
    let textAfter = "";

    // 1. Extract Mermaid diagrams
    if (text.includes('<MERMAID>') && text.includes('</MERMAID>')) {
        const parts = text.split('<MERMAID>');
        textBefore = parts[0];
        mermaidCode = parts[1].split('</MERMAID>')[0].trim();
        textAfter = parts[1].split('</MERMAID>')[1] || '';
    }

    // 2. Extract Charts - Strict XML tags
    if (textBefore.includes('<CHART>') && textBefore.includes('</CHART>')) {
        const chartParts = textBefore.split('<CHART>');
        textBefore = chartParts[0];
        chartJsonRaw = chartParts[1].split('</CHART>')[0].trim();
        const chartAfter = chartParts[1].split('</CHART>')[1] || '';
        textAfter = chartAfter + textAfter;
    }
    // Check in remaining text too
    else if (text.includes('<CHART>') && text.includes('</CHART>') && !mermaidCode) {
        const parts = text.split('<CHART>');
        textBefore = parts[0];
        chartJsonRaw = parts[1].split('</CHART>')[0].trim();
        textAfter = parts[1].split('</CHART>')[1] || '';
    }
    // Fallback: Broken markdown
    else if (textBefore.match(/```[a-zA-Z]*\n*chart\n*({[\s\S]*?})\n*```/i)) {
        const match = textBefore.match(/```[a-zA-Z]*\n*chart\n*({[\s\S]*?})\n*```/i);
        chartJsonRaw = match[1].trim();
        textBefore = textBefore.substring(0, match.index);
        textAfter = textBefore.substring(match.index + match[0].length) + textAfter;
    }
    // Original markdown
    else if (textBefore.includes('```chart')) {
        const parts = textBefore.split('```chart');
        textBefore = parts[0];
        chartJsonRaw = parts[1].split('```')[0].trim();
        textAfter = parts[1].split('```').slice(1).join('```') + textAfter;
    }

    let html = safeMd(textBefore);

    // Render chart if found
    if (chartJsonRaw) {
        try {
            const chartConfig = JSON.parse(chartJsonRaw);
            const canvasId = 'chart-' + Math.random().toString(36).substr(2, 9);

            window.pendingCharts.push({ id: canvasId, config: chartConfig });

            html += `<div class="chart-container">
                        <div class="chart-actions">
                            <button class="chart-download-btn" onclick="downloadChart('${canvasId}')">⬇ Download</button>
                        </div>
                        <canvas id="${canvasId}"></canvas>
                     </div>`;
        } catch (e) {
            console.error("Chart JSON Parse Error:", e);
            html += safeMd('```json\n' + chartJsonRaw + '\n```');
        }
    }

    // Render Mermaid diagram if found
    if (mermaidCode) {
        const mermaidId = 'mermaid-' + (++mermaidCounter);
        html += `<div class="mermaid-container">
                    <div class="mermaid-header">
                        <span class="mermaid-badge">📐 Architecture Diagram</span>
                        <div class="mermaid-actions">
                            <button class="mermaid-copy-btn" onclick="copyMermaidCode(this, \`${btoa(mermaidCode)}\`)">Copy Code</button>
                            <button class="mermaid-download-btn" onclick="downloadMermaidSvg('${mermaidId}')">⬇ SVG</button>
                        </div>
                    </div>
                    <div class="mermaid-render" id="${mermaidId}">${mermaidCode}</div>
                 </div>`;
        
        // Queue mermaid rendering
        setTimeout(() => {
            try {
                mermaid.run({ nodes: [document.getElementById(mermaidId)] });
            } catch (e) {
                console.warn("Mermaid render failed:", e);
            }
        }, 100);
    }

    if (textAfter) html += safeMd(textAfter);
    return injectCodeCopyButtons(html);
}

// Phase 7 security: sanitize untrusted markdown->HTML (DOMPurify) before it
// reaches innerHTML. App-generated chart/mermaid markup is added separately so
// its onclick handlers survive. No-op if DOMPurify failed to load (offline).
function safeMd(text) {
    const out = marked.parse(text || '');
    return window.DOMPurify ? window.DOMPurify.sanitize(out, { ADD_TAGS: ['use'], ADD_ATTR: ['target'] }) : out;
}

// Mermaid utility functions
window.copyMermaidCode = function(btn, encodedCode) {
    const code = atob(encodedCode);
    navigator.clipboard.writeText(code).then(() => {
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = 'Copy Code';
            btn.classList.remove('copied');
        }, 2000);
    });
};

window.downloadMermaidSvg = function(mermaidId) {
    const container = document.getElementById(mermaidId);
    if (!container) return;
    const svg = container.querySelector('svg');
    if (!svg) return;

    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type: 'image/svg+ml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cortex-diagram-${mermaidId}.svg`;
    a.click();
    URL.revokeObjectURL(url);
};

function collectPPTRelevantMessages() {
    // Collects only messages that contain charts or analysis text.
    const session = chatSessions.find(s => s.id === currentSessionId);
    if (!session) return [];

    const pptMessages = [];

    session.messages.forEach(msg => {
        if (msg.role !== 'ai') return;

        const text = msg.text;
        if (!text) return;

        const hasChart = text.includes('<CHART>') && text.includes('</CHART>');
        const hasNarrative = text.length > 0;

        if (hasChart || hasNarrative) {
            let charts = [];
            let narrative = text;

            if (hasChart) {
                const chartMatches = text.matchAll(/<CHART>([\s\S]*?)<\/CHART>/g);
                for (const match of chartMatches) {
                    try {
                        const chartJson = JSON.parse(match[1].trim());
                        charts.push(chartJson);
                        narrative = narrative.replace(match[0], '');
                    } catch (e) {
                        console.warn("Failed to parse chart JSON:", e);
                    }
                }
            }

            // Clean up narrative (remove extra whitespace, markdown, mermaid)
            narrative = narrative
                .replace(/<MERMAID>[\s\S]*?<\/MERMAID>/g, '') // Remove mermaid blocks
                .replace(/```[\s\S]*?```/g, '')  // Remove code blocks
                .replace(/\n\n+/g, '\n')        // Normalize line breaks
                .trim();

            if (narrative || charts.length > 0) {
                pptMessages.push({
                    narrative: narrative,
                    charts: charts
                });
            }
        }
    });

    return pptMessages;
}

// ==========================================
// 3b. Generation Mode System (Toggle-Based)
// ==========================================

// Active generation mode state: null | 'pdf' | 'ppt' | 'csv' | 'json'
let activeGenMode = null;
let isDeepThinkActive = false;

// Register the Deep Think toggle
const dtToggle = document.getElementById('deep-think-toggle');
function setDeepThink(on) {
    isDeepThinkActive = on;
    if (!dtToggle) return;
    dtToggle.classList.toggle('active', on);
    const icon = dtToggle.querySelector('.dt-icon');
    if (icon) icon.textContent = on ? '🔥' : '🧠';
}
if (dtToggle) {
    dtToggle.addEventListener('click', () => setDeepThink(!isDeepThinkActive));
}

// Arm the Deep Think engine with a specific HF repo (from the Model Cookbook's
// oversized-model cards) and drop the user into chat to run it via AirLLM.
window.deepThinkModelRepo = "";
window.armDeepThink = function (hfRepo) {
    window.deepThinkModelRepo = hfRepo || "";
    setDeepThink(true);
    if (window.switchSurface) window.switchSurface('chat');
    if (window.showToast) window.showToast('Deep Think armed with ' + (hfRepo || 'default') + ' — ask your question.', 'success');
};

// Arm an Apple MLX model (from the Cookbook). Sets the active provider to a
// `local-mlx:<repo>` value — the exact prefix ai_client.run_contextual_chat
// routes to the MLX engine; the repo downloads from HuggingFace on first use.
window.armMlxModel = function (repo) {
    if (!repo) return;
    const sel = UI.providerSelect;
    const value = 'local-mlx:' + repo;
    let opt = Array.from(sel.options).find(o => o.value === value);
    if (!opt) {
        opt = document.createElement('option');
        opt.value = value;
        opt.textContent = '🍎 MLX: ' + repo.split('/').pop();
        sel.appendChild(opt);
    }
    sel.value = value;
    if (window.switchSurface) window.switchSurface('chat');
    if (window.showToast) window.showToast('MLX model armed: ' + repo + ' — ask your question (first run downloads it).', 'success');
};

// Toast notification for generation status
function showGenToast(message, duration = 3000) {
    let toast = document.querySelector('.gen-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'gen-toast';
        document.body.appendChild(toast);
    }
    toast.innerHTML = `<div class="toast-spinner"></div> ${message}`;
    toast.classList.add('show');

    if (duration > 0) {
        setTimeout(() => toast.classList.remove('show'), duration);
    }
    return toast;
}

function hideGenToast() {
    const toast = document.querySelector('.gen-toast');
    if (toast) toast.classList.remove('show');
}

function setGenMode(mode) {
    const chips = document.querySelectorAll('.gen-chip');
    
    if (activeGenMode === mode) {
        // Toggle off
        activeGenMode = null;
        chips.forEach(c => c.classList.remove('gen-chip-active'));
        UI.chatInput.placeholder = 'Ask anything...';
        UI.pptOptionsRow.classList.add('hidden');
        UI.pptCustomTheme.classList.add('hidden');
        const csvRow0 = document.getElementById('csv-options-row');
        if (csvRow0) csvRow0.classList.add('hidden');
        return;
    }
    
    // Activate new mode
    activeGenMode = mode;
    chips.forEach(c => c.classList.remove('gen-chip-active'));
    
    const modeLabels = {
        web: '🌐 Web Search active — your query will be searched online first',
        pdf: '📄 PDF mode active — your next message will generate a PDF',
        ppt: '📊 PPT mode active — your next message will generate a PowerPoint',
        csv: '📋 CSV mode active — your next message will generate a CSV',
        visualize: '📈 Visualize mode active — your next message will generate a forecast chart',
        json: '📦 JSON mode active — your next message will export graph as JSON'
    };

    // Highlight the active chip
    const chipMap = { web: UI.genWebBtn, pdf: UI.genPdfBtn, ppt: UI.genPptBtn, csv: UI.genCsvBtn, visualize: UI.genVisualizeBtn, json: UI.genJsonBtn };
    if (chipMap[mode]) chipMap[mode].classList.add('gen-chip-active');
    
    UI.chatInput.placeholder = modeLabels[mode] || 'Ask anything...';
    
    // Show PPT options row (slide count + theme) only for PPT mode
    if (mode === 'ppt') {
        UI.pptOptionsRow.classList.remove('hidden');
    } else {
        UI.pptOptionsRow.classList.add('hidden');
        UI.pptCustomTheme.classList.add('hidden');
    }
    // Show the column-count input only for CSV mode.
    const csvRow = document.getElementById('csv-options-row');
    if (csvRow) csvRow.classList.toggle('hidden', mode !== 'csv');

    // For JSON, export immediately (no prompt needed)
    if (mode === 'json') {
        exportJsonDirect();
        return;
    }
    
    showGenToast(`${modeLabels[mode].split('—')[0].trim()} — Type your prompt and send`, 2500);
    UI.chatInput.focus();
}

function exportJsonDirect() {
    if (!currentGraphData) {
        showGenToast('⚠️ No graph data to export. Initialize the agent first.', 2500);
    } else {
        const blob = new Blob([JSON.stringify(currentGraphData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cortex-brain-export.json';
        a.click();
        URL.revokeObjectURL(url);
        showGenToast('✅ JSON exported successfully', 2000);
    }
    // Reset mode
    activeGenMode = null;
    document.querySelectorAll('.gen-chip').forEach(c => c.classList.remove('gen-chip-active'));
    UI.chatInput.placeholder = 'Ask anything...';
}

// Serialize the LAST rendered <table> in the chat into CSV text — guarantees
// the downloaded file matches exactly what the user sees in the chat.
function csvFromRenderedTable() {
    const tables = document.querySelectorAll('#chat-output .chat-msg.ai table');
    if (!tables.length) return '';
    const table = tables[tables.length - 1];
    const rows = [];
    table.querySelectorAll('tr').forEach(tr => {
        const cells = Array.from(tr.querySelectorAll('th,td'))
            .map(td => (td.innerText || td.textContent || '').trim());
        if (cells.some(c => c)) rows.push('| ' + cells.join(' | ') + ' |');
    });
    // Re-insert a markdown separator after the header so the backend parser
    // (which skips the |---| row) treats row 0 as the header.
    if (rows.length >= 1) {
        const ncols = (rows[0].match(/\|/g) || []).length - 1;
        rows.splice(1, 0, '|' + Array(ncols).fill('---').join('|') + '|');
    }
    return rows.length >= 2 ? rows.join('\n') : '';
}

// Extract only the FIRST contiguous Markdown table (header + separator + rows),
// ignoring any stray pipe lines or a second table elsewhere in the response.
function firstMarkdownTableBlock(text) {
    const lines = (text || '').split('\n');
    let start = -1;
    for (let i = 0; i < lines.length - 1; i++) {
        if (/^\s*\|.*\|\s*$/.test(lines[i]) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
            start = i; break;
        }
    }
    if (start === -1) return '';
    const block = [];
    for (let i = start; i < lines.length; i++) {
        if (/^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i].trim());
        else if (block.length) break;
    }
    return block.length >= 2 ? block.join('\n') : '';
}

// Auto-export after AI response completes
async function autoExportGeneration(responseText) {
    if (!activeGenMode || activeGenMode === 'json' || activeGenMode === 'web' || activeGenMode === 'visualize') return;
    
    const session = chatSessions.find(s => s.id === currentSessionId);
    const project = projects.find(p => p.id === currentProjectId);
    const projectName = project ? project.name : 'Cortex';
    const sessionName = session ? (session.title || 'Analysis Report') : 'Analysis Report';
    const modelUsed = getEffectiveProvider() || 'local';
    
    // Build the message payload from the latest response
    const messages = [{ narrative: responseText, charts: [] }];
    
    // Extract any charts from the response
    if (responseText.includes('<CHART>') && responseText.includes('</CHART>')) {
        const chartMatches = responseText.matchAll(/<CHART>([\s\S]*?)<\/CHART>/g);
        for (const match of chartMatches) {
            try {
                messages[0].charts.push(JSON.parse(match[1].trim()));
                messages[0].narrative = messages[0].narrative.replace(match[0], '');
            } catch (e) { /* skip bad chart JSON */ }
        }
        messages[0].narrative = messages[0].narrative.trim();
    }
    
    const mode = activeGenMode;
    const toast = showGenToast(`Generating ${mode.toUpperCase()} file...`, 0);
    
    try {
        let response;
        
        if (mode === 'pdf') {
            response = await fetch('/api/export-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: String(currentSessionId),
                    projectName, sessionName, modelUsed, messages
                })
            });
        } else if (mode === 'ppt') {
            const themeValue = UI.pptThemeSelect.value;
            const customThemeDesc = (themeValue === 'custom') ? (UI.pptCustomTheme.value.trim() || '') : '';
            const slideCount = parseInt(UI.pptSlideCount.value) || 10;
            response = await fetch('/api/export-pptx', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: String(currentSessionId),
                    projectName, sessionName, modelUsed,
                    theme: themeValue === 'custom' ? 'custom' : (themeValue || 'dark'),
                    customTheme: customThemeDesc,
                    slideCount: slideCount,
                    messages
                })
            });
        } else if (mode === 'csv') {
            // WYSIWYG: serialize the table the user ACTUALLY sees in chat (the
            // last AI message's rendered <table>), so the file matches the chat
            // exactly. Falls back to text extraction only if no table rendered.
            let csvText = csvFromRenderedTable();
            if (!csvText) {
                // Take only the FIRST contiguous Markdown-table block (header +
                // ---separator + consecutive | rows) — never merge a stray second
                // table (which produced the garbled file before).
                csvText = firstMarkdownTableBlock(responseText);
            }
            if (!csvText) {
                const fence = responseText.match(/```(?:csv)?\s*\n([\s\S]*?)```/i);
                if (fence) csvText = fence[1].trim();
            }
            response = await fetch('/api/export-csv', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sessionId: String(currentSessionId),
                    csvText,
                    messages
                })
            });
        }
        
        if (!response || !response.ok) throw new Error(`${mode.toUpperCase()} generation failed`);
        
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const et = mode === 'ppt' ? 'pptx' : mode;
        a.download = `cortex-${Date.now()}.${et}`;
        a.click();
        URL.revokeObjectURL(url);
        
        toast.innerHTML = `✅ ${mode.toUpperCase()} exported successfully`;
        setTimeout(() => hideGenToast(), 2000);
    } catch (err) {
        toast.innerHTML = `❌ ${mode.toUpperCase()} Export Failed: ${err.message}`;
        setTimeout(() => hideGenToast(), 3000);
        console.error(err);
    }
    
    // Reset generation mode
    activeGenMode = null;
    document.querySelectorAll('.gen-chip').forEach(c => c.classList.remove('gen-chip-active'));
    UI.chatInput.placeholder = 'Ask anything...';
    UI.pptOptionsRow.classList.add('hidden');
    UI.pptCustomTheme.classList.add('hidden');
}

// Wire up gen chips as toggles
UI.genWebBtn.addEventListener('click', () => setGenMode('web'));
UI.genPdfBtn.addEventListener('click', () => setGenMode('pdf'));
UI.genPptBtn.addEventListener('click', () => setGenMode('ppt'));
UI.genCsvBtn.addEventListener('click', () => setGenMode('csv'));
UI.genVisualizeBtn.addEventListener('click', () => setGenMode('visualize'));
UI.genJsonBtn.addEventListener('click', () => setGenMode('json'));

// Show/hide custom theme input based on theme select
UI.pptThemeSelect.addEventListener('change', () => {
    if (UI.pptThemeSelect.value === 'custom') {
        UI.pptCustomTheme.classList.remove('hidden');
        UI.pptCustomTheme.focus();
    } else {
        UI.pptCustomTheme.classList.add('hidden');
    }
});


// ---- Artifact Controls: Inject Copy buttons on code blocks ----
function injectCodeCopyButtons(html) {
    return html.replace(/<pre><code([^>]*)>/g, (match, attrs) => {
        const btnId = 'copy-' + Math.random().toString(36).substr(2, 7);
        let lang = 'CODE';
        const langMatch = attrs.match(/class="language-([^"]*)"/);
        if (langMatch) lang = langMatch[1].toUpperCase();
        return `<pre><div class="code-header"><span class="code-lang">${lang}</span><div class="code-actions"><button class="code-copy-btn" id="${btnId}" onclick="copyCodeBlock(this)">Copy</button></div></div><code${attrs}>`;
    });
}

// Global copy handler
window.copyCodeBlock = function (btn) {
    const pre = btn.closest('pre');
    const code = pre.querySelector('code');
    if (!code) return;

    const text = code.innerText || code.textContent;
    navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
        }, 2000);
    }).catch(() => {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
};

// Global chart download handler
window.downloadChart = function (canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const link = document.createElement('a');
    link.download = `cortex-chart-${canvasId}.png`;
    link.href = canvas.toDataURL('image/png', 1.0);
    link.click();
};

function initPendingCharts() {
    if (!window.pendingCharts || window.pendingCharts.length === 0) return;

    window.pendingCharts.forEach(item => {
        const canvas = document.getElementById(item.id);
        if (canvas) {
            const ctx = canvas.getContext('2d');
            const bgColors = item.config.type === 'pie' || item.config.type === 'doughnut'
                ? ['#38bdf8', '#a855f7', '#ec4899', '#10b981', '#f59e0b']
                : 'rgba(56, 189, 248, 0.4)';

            // Theme-aware chart text so axes/legend are readable in light mode.
            const isLight = document.documentElement.getAttribute('data-theme') === 'light';
            const txtColor = isLight ? '#1a1a1a' : '#fff';
            const tickColor = isLight ? '#475569' : '#94a3b8';
            const gridColor = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.05)';

            const chartInstance = new Chart(ctx, {
                type: item.config.type || 'bar',
                data: {
                    labels: item.config.labels,
                    datasets: [{
                        label: item.config.label || 'Dataset',
                        data: item.config.data,
                        backgroundColor: bgColors,
                        borderColor: '#38bdf8',
                        borderWidth: 1,
                        fill: item.config.type === 'line'
                    }]
                },
                options: {
                    responsive: true,
                    plugins: { legend: { labels: { color: txtColor } } },
                    scales: ['pie', 'doughnut', 'radar', 'polarArea'].includes(item.config.type) ? {} : {
                        x: { ticks: { color: tickColor }, grid: { color: gridColor } },
                        y: { ticks: { color: tickColor }, grid: { color: gridColor } }
                    }
                }
            });

            // Register in chart registry for ghost canvas fix
            window.chartRegistry[item.id] = chartInstance;
        }
    });
    window.pendingCharts = [];
}

// Destroy all tracked chart instances (ghost canvas fix)
function destroyAllCharts() {
    Object.keys(window.chartRegistry).forEach(id => {
        if (window.chartRegistry[id]) {
            window.chartRegistry[id].destroy();
        }
    });
    window.chartRegistry = {};
}

// ==========================================
// 4. Native OS File/Folder Browsing
// ==========================================
async function handleNativeBrowse(type) {
    try {
        const response = await fetch(`/api/browse?type=${type}`);
        const data = await response.json();
        if (data.path) UI.input.value = data.path;
    } catch (err) {
        console.error("Failed to open native browser:", err);
    }
}

document.getElementById('browse-folder-btn').addEventListener('click', () => handleNativeBrowse('folder'));
document.getElementById('browse-file-btn').addEventListener('click', () => handleNativeBrowse('file'));

// ==========================================
// 5. Project Workspaces (Cross-Chat Context)
// ==========================================
function saveProjects() {
    localStorage.setItem('mp_projects', JSON.stringify(projects));
    renderProjects();
}

function createNewProject() {
    const input = document.createElement('input');
    input.className = 'project-name-input';
    input.placeholder = 'Project name...';
    input.type = 'text';

    UI.projectList.prepend(input);
    input.focus();

    const finalize = () => {
        const name = input.value.trim() || 'Untitled Project';
        input.remove();

        const newProject = {
            id: Date.now(),
            name: name,
            graphData: null,
            chatIds: []
        };

        const firstChatId = Date.now() + 1;
        chatSessions.unshift({ id: firstChatId, title: "New Conversation", messages: [], projectId: newProject.id });
        newProject.chatIds.push(firstChatId);

        projects.unshift(newProject);
        currentProjectId = newProject.id;

        saveProjects();
        saveSessions();
        loadSession(firstChatId);
    };

    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') finalize();
    });
    input.addEventListener('blur', finalize);
}

function setActiveProject(projectId) {
    currentProjectId = projectId;
    const project = projects.find(p => p.id === projectId);

    if (project && project.graphData) {
        currentGraphData = project.graphData;
        renderUniverse(currentGraphData.nodes, currentGraphData.cluster_titles);
        UI.searchWrapper.classList.remove('hidden');
    }

    if (project && project.chatIds.length > 0) {
        loadSession(project.chatIds[0]);
    }

    renderProjects();
    renderHistory();
}

function deleteProject(projectId) {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    if (!confirm(`Delete project "${project.name}" and all its chats?`)) return;

    // Remove all chats belonging to this project
    chatSessions = chatSessions.filter(s => !project.chatIds.includes(s.id));

    // Remove the project
    projects = projects.filter(p => p.id !== projectId);

    // Reset active state if needed
    if (currentProjectId === projectId) {
        currentProjectId = null;
    }

    saveProjects();
    saveSessions();

    // Load a remaining session or create new
    if (chatSessions.length === 0) {
        createNewSession();
    } else {
        loadSession(chatSessions[0].id);
    }
}

function renderProjects() {
    if (!UI.projectList) return;
    UI.projectList.innerHTML = '';

    if (projects.length === 0) {
        UI.projectList.innerHTML = '<div class="empty-state">No projects yet</div>';
        return;
    }

    projects.forEach(project => {
        const div = document.createElement('div');
        div.className = `project-item ${project.id === currentProjectId ? 'active' : ''}`;
        div.innerHTML = `
            <span class="project-name">📂 ${project.name}</span>
            <div class="item-actions">
                <span class="project-count">${project.chatIds.length}</span>
                <button class="item-delete-btn" title="Delete project" onclick="event.stopPropagation(); deleteProject(${project.id})">✕</button>
            </div>
        `;
        div.onclick = () => setActiveProject(project.id);
        UI.projectList.appendChild(div);

        // Show nested chats if this project is active
        if (project.id === currentProjectId) {
            const chatsContainer = document.createElement('div');
            chatsContainer.className = 'project-chats';

            project.chatIds.forEach(chatId => {
                const session = chatSessions.find(s => s.id === chatId);
                if (!session) return;

                const chatDiv = document.createElement('div');
                chatDiv.className = `history-item ${session.id === currentSessionId ? 'active' : ''}`;
                chatDiv.innerHTML = `
                    <span class="history-title">${session.title}</span>
                    <button class="item-delete-btn" title="Delete chat" onclick="event.stopPropagation(); deleteSingleChat(${session.id}, ${project.id})">✕</button>
                `;
                chatDiv.onclick = (e) => {
                    if (e.target.closest('.item-delete-btn')) return;
                    e.stopPropagation();
                    loadSession(session.id);
                };
                // Double click to rename
                chatDiv.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    renameChat(session.id, chatDiv);
                });
                chatsContainer.appendChild(chatDiv);
            });

            // Add "new chat" in project
            const addChatDiv = document.createElement('div');
            addChatDiv.className = 'history-item add-chat-btn';
            addChatDiv.innerHTML = '+ New chat';
            addChatDiv.onclick = (e) => {
                e.stopPropagation();
                createChatInProject(project.id);
            };
            chatsContainer.appendChild(addChatDiv);

            UI.projectList.appendChild(chatsContainer);
        }
    });
}

// Make deleteProject globally accessible
window.deleteProject = deleteProject;

function createChatInProject(projectId) {
    const project = projects.find(p => p.id === projectId);
    if (!project) return;

    const newId = Date.now();
    chatSessions.unshift({ id: newId, title: "New Conversation", messages: [], projectId: projectId });
    project.chatIds.push(newId);

    saveProjects();
    saveSessions();
    loadSession(newId);
}

UI.newProjectBtn.addEventListener('click', createNewProject);

// ==========================================
// 6. Chat Session Management
// ==========================================
function initSessions() {
    if (chatSessions.length === 0) createNewSession();
    else loadSession(chatSessions[0].id);
}

function createNewSession() {
    const newId = Date.now();
    chatSessions.unshift({ id: newId, title: "New Conversation", messages: [] });
    saveSessions();
    loadSession(newId);
}

function saveSessions() {
    localStorage.setItem('mp_sessions', JSON.stringify(chatSessions));
    renderHistory();
}

function showWelcomeState() {
    if (UI.welcomeState) {
        UI.welcomeState.classList.remove('hidden');
    }
}

function hideWelcomeState() {
    if (UI.welcomeState) {
        UI.welcomeState.classList.add('hidden');
    }
}

function loadSession(id) {
    currentSessionId = id;
    const session = chatSessions.find(s => s.id === id);
    if (!session) return;

    // Determine which project this chat belongs to
    if (session.projectId) {
        currentProjectId = session.projectId;
        const project = projects.find(p => p.id === session.projectId);
        if (project && project.graphData) {
            currentGraphData = project.graphData;
        }
    }

    // Ghost Canvas Fix: Destroy existing chart instances before clearing DOM
    destroyAllCharts();
    window.pendingCharts = [];

    UI.chatOutput.innerHTML = '';

    if (session.messages.length === 0) {
        showWelcomeState();
    } else {
        hideWelcomeState();
        session.messages.forEach(msg => {
            if (msg.role === 'ai') {
                UI.chatOutput.innerHTML += `<div class="chat-msg ai">${formatChatMessage(msg.text)}</div>`;
            } else {
                UI.chatOutput.innerHTML += msg.html;
            }
        });
    }
    UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;
    initPendingCharts();
    renderHistory();
    renderProjects();
}

function saveMessageToSession(role, rawText, htmlContent) {
    const session = chatSessions.find(s => s.id === currentSessionId);
    if (!session) return;

    if (session.messages.length === 0 && role === 'user') {
        session.title = rawText.length > 25 ? rawText.substring(0, 25) + "..." : rawText;
    }

    session.messages.push({ role: role, text: rawText, html: htmlContent });
    saveSessions();
}

// Delete a single chat (standalone or from a project)
function deleteSingleChat(chatId, projectId = null) {
    const session = chatSessions.find(s => s.id === chatId);
    if (!session) return;

    // Remove from sessions array
    chatSessions = chatSessions.filter(s => s.id !== chatId);

    // If part of a project, remove from project's chatIds
    if (projectId) {
        const project = projects.find(p => p.id === projectId);
        if (project) {
            project.chatIds = project.chatIds.filter(id => id !== chatId);
            saveProjects();
        }
    }

    saveSessions();

    // If we deleted the active session, load another
    if (currentSessionId === chatId) {
        if (chatSessions.length === 0) {
            createNewSession();
        } else {
            loadSession(chatSessions[0].id);
        }
    }
}

// Make it globally accessible for onclick handlers
window.deleteSingleChat = deleteSingleChat;

// Rename a chat inline
function renameChat(chatId, element) {
    const session = chatSessions.find(s => s.id === chatId);
    if (!session) return;

    const titleSpan = element.querySelector('.history-title');
    if (!titleSpan) return;

    const currentTitle = session.title;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename-input';
    input.value = currentTitle;

    titleSpan.replaceWith(input);
    input.focus();
    input.select();

    const finish = () => {
        const newTitle = input.value.trim() || currentTitle;
        session.title = newTitle;

        const span = document.createElement('span');
        span.className = 'history-title';
        span.textContent = newTitle;
        input.replaceWith(span);

        saveSessions();
        renderProjects();
    };

    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            finish();
        }
    });
    input.addEventListener('blur', finish);
}

function renderHistory() {
    const historyList = document.getElementById('history-list');
    historyList.innerHTML = '';

    // Show only standalone chats (not in any project)
    const standaloneSessions = chatSessions.filter(s => !s.projectId);

    if (standaloneSessions.length === 0) {
        historyList.innerHTML = '<div class="empty-state">No standalone chats</div>';
        return;
    }

    standaloneSessions.forEach(session => {
        const div = document.createElement('div');
        div.className = `history-item ${session.id === currentSessionId ? 'active' : ''}`;
        div.innerHTML = `
            <span class="history-title">${session.title}</span>
            <button class="item-delete-btn" title="Delete chat" onclick="event.stopPropagation(); deleteSingleChat(${session.id})">✕</button>
        `;
        div.onclick = (e) => {
            if (e.target.closest('.item-delete-btn')) return;
            currentProjectId = null;
            loadSession(session.id);
        };
        // Double click to rename
        div.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            renameChat(session.id, div);
        });
        historyList.appendChild(div);
    });
}

UI.newChatBtn.addEventListener('click', () => {
    currentProjectId = null;
    createNewSession();
});
document.getElementById('clear-history-btn').addEventListener('click', () => {
    if (!confirm('Delete ALL chats and projects? This cannot be undone.')) return;
    chatSessions = [];
    projects = [];
    currentProjectId = null;
    localStorage.removeItem('mp_sessions');
    localStorage.removeItem('mp_projects');
    renderProjects();
    initSessions();
});

initSessions();

// ==========================================
// 7. Welcome State Suggestion Chips
// ==========================================
document.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        const prompt = chip.getAttribute('data-prompt');
        if (prompt) {
            UI.chatInput.value = prompt;
            UI.chatInput.focus();
            // Auto-resize
            UI.chatInput.style.height = 'auto';
            UI.chatInput.style.height = Math.min(UI.chatInput.scrollHeight, 150) + 'px';
        }
    });
});

// ==========================================
// 8. API & Map Interactions
// ==========================================
// Preload an Ollama model into memory when it's selected so the first prompt
// doesn't pay the cold-load stall. Debounced + fire-and-forget.
let _warmupTimer = null;
window.warmupModel = function(provider) {
    if (!provider || !provider.startsWith('local:')) return;
    clearTimeout(_warmupTimer);
    _warmupTimer = setTimeout(() => {
        fetch('/api/warmup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: provider })
        }).catch(() => {});
    }, 400);
};

UI.providerSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    warmupModel(getEffectiveProvider());

    // API Key visibility for cloud providers
    val.startsWith('local') ? UI.keyInput.classList.add('hidden') : UI.keyInput.classList.remove('hidden');
    
    // Custom MLX repo visibility
    val === 'local-ml:custom' ? UI.customMlInput.classList.remove('hidden') : UI.customMlInput.classList.add('hidden');
    
    // Custom Cloud input visibility
    val === 'cloud:custom' ? UI.customCloudInput.classList.remove('hidden') : UI.customCloudInput.classList.add('hidden');
    const customHint = document.getElementById('custom-cloud-hint');
    if (customHint) val === 'cloud:custom' ? customHint.classList.remove('hidden') : customHint.classList.add('hidden');
});

// Universal key routing (mirrors backend _detect_key_family): identify the
// provider from the API key's prefix so the user never has to match the key to
// the right dropdown entry (e.g. a Groq `gsk_` key vs xAI Grok `xai-`).
function detectCloudFamilyFromKey(key) {
    const k = (key || '').trim();
    if (k.startsWith('sk-ant-')) return 'anthropic';
    if (k.startsWith('gsk_'))    return 'groq';
    if (k.startsWith('xai-'))    return 'xai';
    if (k.startsWith('AIza'))    return 'gemini';
    if (k.startsWith('sk-'))     return 'openai';   // sk-, sk-proj-, ...
    return null;
}
// The dropdown option value that represents each family's default model.
const CLOUD_FAMILY_DEFAULT_VALUE = {
    anthropic: 'claude-3-5-sonnet-latest',
    groq:      'groq/llama-3.3-70b-versatile',
    xai:       'xai/grok-2-latest',
    gemini:    'gemini/gemini-3-flash-preview',
    openai:    'gpt-4o',
};
function familyOfProviderValue(val) {
    const p = (val || '').toLowerCase();
    if (p.startsWith('gemini/')) return 'gemini';
    if (p.startsWith('groq/')) return 'groq';
    if (p.startsWith('xai/') || p.startsWith('grok')) return 'xai';
    if (p.startsWith('anthropic/') || p.startsWith('claude')) return 'anthropic';
    if (p.startsWith('openai/') || p.startsWith('gpt') || p.startsWith('o1') || p.startsWith('o3')) return 'openai';
    return null;
}
let _keyDetectTimer = null;
UI.keyInput.addEventListener('input', () => {
    clearTimeout(_keyDetectTimer);
    _keyDetectTimer = setTimeout(() => {
        const fam = detectCloudFamilyFromKey(UI.keyInput.value);
        if (!fam) return;
        const cur = UI.providerSelect.value;
        // Never override a local model or the Custom Cloud escape hatch, and
        // don't fight a selection that already matches the key's family.
        if (cur.startsWith('local') || cur === 'cloud:custom') return;
        if (familyOfProviderValue(cur) === fam) return;
        const target = CLOUD_FAMILY_DEFAULT_VALUE[fam];
        if (target && [...UI.providerSelect.options].some(o => o.value === target)) {
            UI.providerSelect.value = target;
            UI.providerSelect.dispatchEvent(new Event('change'));
        }
    }, 400);
});

function getEffectiveProvider() {
    const provider = UI.providerSelect.value;
    if (provider === 'local-ml:custom') {
        const customRepo = UI.customMlInput.value.trim();
        return customRepo ? `local-ml:${customRepo}` : 'local-ml:ml-community/Meta-Llama-3-8B-Instruct-4bit';
    }
    if (provider === 'cloud:custom') {
        const customCloud = UI.customCloudInput.value.trim();
        return customCloud ? customCloud : 'gemini/gemini-2.0-flash';
    }
    return provider;
}

UI.btn.addEventListener('click', async () => {
    const dirPath = UI.input.value.trim();
    const provider = getEffectiveProvider();
    const apiKey = UI.keyInput.value.trim();

    if (!dirPath) return alert("Please point the agent to a valid folder directory.");
    if (!provider.startsWith('local') && !apiKey) return alert("Please enter your API key.");

    UI.btn.disabled = true;

    // Phase 1: Parsing & embedding
    UI.btn.innerText = "⏳ Scanning Files...";
    UI.btn.classList.add('processing');

    try {
        const response = await fetch('/api/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directory_path: dirPath, ai_provider: provider, api_key: apiKey })
        });
        const data = await response.json();

        if (data.error) {
            alert(data.error);
            UI.btn.innerText = "Initialize Agent";
            UI.btn.disabled = false;
            UI.btn.classList.remove('processing');
            return;
        }

        // ========== INSTANT MAP RENDER ==========
        currentGraphData = data;
        UI.searchWrapper.classList.remove('hidden');
        renderUniverse(data.nodes, data.cluster_titles);

        // Hide welcome state and show system message
        hideWelcomeState();

        const sysAlert = `<div class="chat-msg ai" style="color:var(--accent);"><i>System: Successfully mapped ${data.nodes.length} nodes into active memory.</i></div>`;
        UI.chatOutput.innerHTML += sysAlert;
        saveMessageToSession('system', 'mapped', sysAlert);

        // Store graph data at project level if inside a project
        if (currentProjectId) {
            const project = projects.find(p => p.id === currentProjectId);
            if (project) {
                project.graphData = data;
                saveProjects();
            }
        }

        // ========== ASYNC TITLE ENRICHMENT ==========
        fetchClusterTitlesAsync(provider, apiKey);

    } catch (err) {
        console.error("Engine failure:", err);
        alert("Engine Failure: " + err.message);
    } finally {
        UI.btn.innerText = "Initialize Agent";
        UI.btn.disabled = false;
        UI.btn.classList.remove('processing');
    }
});

// Async cluster title enrichment — fires AFTER map is already visible
async function fetchClusterTitlesAsync(provider, apiKey) {
    try {
        const titleNotice = `<div class="chat-msg ai" style="color:var(--text-secondary);font-style:italic;" id="title-loading-notice">⏳ Generating AI cluster titles in background...</div>`;
        UI.chatOutput.innerHTML += titleNotice;
        UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;

        const res = await fetch('/api/cluster-titles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ai_provider: provider, api_key: apiKey })
        });
        const titleData = await res.json();

        if (titleData.cluster_titles && currentGraphData) {
            currentGraphData.cluster_titles = titleData.cluster_titles;
            renderUniverse(currentGraphData.nodes, currentGraphData.cluster_titles);

            if (currentProjectId) {
                const project = projects.find(p => p.id === currentProjectId);
                if (project) {
                    project.graphData = currentGraphData;
                    saveProjects();
                }
            }

            const notice = document.getElementById('title-loading-notice');
            if (notice) {
                notice.innerHTML = '✅ AI cluster titles generated successfully.';
                notice.style.color = '#10b981';
            }
        }
    } catch (err) {
        console.warn("Cluster title enrichment failed (non-critical):", err);
        const notice = document.getElementById('title-loading-notice');
        if (notice) {
            notice.innerHTML = '⚠️ Cluster titles unavailable — map still fully functional.';
            notice.style.color = '#f59e0b';
        }
    }
}

const executeGlobalSearch = async () => {
    const query = UI.searchInput.value.trim();
    if (!query) {
        if (MindGraph) MindGraph.nodeColor(node => getClusterColor(node.cluster_id)).linkOpacity(0.15);
        return;
    }
    try {
        const response = await fetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query })
        });
        const data = await response.json();
        if (!data || !data.results || data.results.length === 0) return;

        const matchIds = new Set(data.results.map(r => r.id));
        if (MindGraph) {
            MindGraph
                .nodeColor(node => matchIds.has(node.id) ? '#ffffff' : 'rgba(255, 255, 255, 0.04)')
                .linkOpacity(link => (matchIds.has(link.source.id) || matchIds.has(link.target.id)) ? 0.25 : 0.01);

            const bestNode = currentGraphData.nodes.find(n => n.id === data.results[0].id);
            if (bestNode) {
                const distRatio = 1 + 70 / (Math.hypot(bestNode.x, bestNode.y, bestNode.z) || 0.001);
                MindGraph.cameraPosition({ x: bestNode.x * distRatio, y: bestNode.y * distRatio, z: bestNode.z * distRatio }, bestNode, 1600);
            }
        }
    } catch (err) { console.error(err); }
};

UI.searchBtn.addEventListener('click', executeGlobalSearch);
UI.searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') executeGlobalSearch(); });

// ==========================================
// 9. Chat File Upload (Dynamic Injection)
// ==========================================
const attachBtn = document.getElementById('attach-btn');
const fileUpload = document.getElementById('file-upload');

attachBtn.addEventListener('click', () => fileUpload.click());

fileUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) processMainChatFile(file);
});

async function processMainChatFile(file) {
    if (!file) return;

    // Hide welcome state when file is uploaded
    hideWelcomeState();

    const uploadingHtml = `<div class="chat-msg ai" style="color:var(--accent);"><i>System: Reading and injecting <b>${file.name}</b> into memory...</i></div>`;
    UI.chatOutput.innerHTML += uploadingHtml;
    UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;
    saveMessageToSession('system', 'uploading', uploadingHtml);

    // For images, also capture raw base64 so a vision model (gemma3, llava…)
    // sees the actual picture, not just OCR text.
    lastUploadedImageB64 = null;
    if (file.type && file.type.startsWith('image/')) {
        try {
            lastUploadedImageB64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1] || null);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        } catch (_) { lastUploadedImageB64 = null; }
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();

        if (data.error) throw new Error(data.error);

        // Silently update the graph data for search — do NOT call renderUniverse().
        // The 3D graph is only rendered via "Initialize Agent" (directory scan).
        // File uploads just add to the vector search index without disrupting the UI.
        if (!currentGraphData) currentGraphData = { cluster_titles: {} };
        currentGraphData.nodes = data.nodes;

        const successHtml = `<div class="chat-msg ai" style="color:#10b981;"><i>System: <b>${file.name}</b> successfully embedded into local vector space! You can now ask questions about it.</i></div>`;
        UI.chatOutput.innerHTML += successHtml;
        saveMessageToSession('system', 'success', successHtml);

        // Store the extracted content directly from the server response
        // This is the full raw text (OCR, PDF, etc.x) BEFORE embedding/chunking
        if (data.extracted_content) {
            lastUploadedContent = data.extracted_content;
            lastUploadedFilename = data.filename || file.name;
            console.log(`📄 Stored ${lastUploadedContent.length} chars of extracted content from ${lastUploadedFilename}`);
        }

    } catch (err) {
        UI.chatOutput.innerHTML += `<div class="chat-msg ai" style="color:#ef4444;"><i>System: Failed to inject file.</i></div>`;
    }
    UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;
    // Reset file input so same file can be uploaded again
    fileUpload.value = '';
}

// Drag-and-drop a file onto the main chat input to attach it (same pipeline
// as the + button, including image→vision).
(function wireMainChatDrop() {
    const dropZone = UI.chatInput ? (UI.chatInput.closest('.chat-input-wrapper') || UI.chatInput.parentElement) : null;
    if (!dropZone) return;
    ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag-over');
    }));
    dropZone.addEventListener('drop', (e) => {
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) processMainChatFile(file);
    });
})();

// ==========================================
// 10. Universal Chat Execution (with AbortController)
// ==========================================
let isCurrentlyProcessing = false;

function setProcessingState(isProcessing) {
    isCurrentlyProcessing = isProcessing;
    if (isProcessing) {
        UI.chatSendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>';
        UI.chatSendBtn.classList.add('stop-mode');
        UI.chatSendBtn.title = 'Stop generation';
        UI.chatInput.disabled = true;
    } else {
        UI.chatSendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
        UI.chatSendBtn.classList.remove('stop-mode');
        UI.chatSendBtn.title = 'Send message';
        UI.chatInput.disabled = false;
        activeAbortController = null;
        // Force-ensure the input is truly interactive
        UI.chatInput.focus();
    }
}

async function executeAgentChat() {
    // If currently generating, abort instead
    if (isCurrentlyProcessing && activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;

        // Stop the zombie poller that watches activeResponseDiv, and tell the
        // server to break its generation loop so it frees the model instead of
        // the next prompt queueing behind a still-running 27B.
        if (window.chatCheckDoneInterval) {
            clearInterval(window.chatCheckDoneInterval);
            window.chatCheckDoneInterval = null;
        }
        try {
            if (window.brainWs && window.brainWs.readyState === WebSocket.OPEN) {
                window.brainWs.send(JSON.stringify({ type: 'cancel', interaction_mode: 'cancel' }));
            }
        } catch (_) {}
        window.activeResponseDiv = null;

        // Reset generation mode if it was active
        if (activeGenMode) {
            activeGenMode = null;
            document.querySelectorAll('.gen-chip').forEach(c => c.classList.remove('gen-chip-active'));
            UI.pptOptionsRow.classList.add('hidden');
            UI.pptCustomTheme.classList.add('hidden');
        }

        setProcessingState(false);

        const abortHtml = `<div class="chat-msg ai" style="color:var(--text-secondary);font-style:italic;">Generation stopped by user.</div>`;
        UI.chatOutput.innerHTML += abortHtml;
        UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;
        UI.chatInput.placeholder = 'Ask anything...';
        return;
    }

    const question = UI.chatInput.value.trim();
    if (!question) return;

    // Hide welcome state on first message
    hideWelcomeState();

    // Preserve line breaks from textarea for display
    const displayQuestion = question.replace(/\n/g, '<br>');
    const encoded = encodeURIComponent(question);
    const userHtml = `<div class="chat-msg user">${displayQuestion}
        <div class="user-msg-actions">
            <button class="user-msg-btn" title="Copy" onclick="copyUserMsg('${encoded}')">📋</button>
            <button class="user-msg-btn" title="Edit / resend" onclick="editUserMsg('${encoded}')">✏️</button>
        </div></div>`;
    UI.chatOutput.innerHTML += userHtml;
    saveMessageToSession('user', question, userHtml);

    UI.chatInput.value = '';
    UI.chatInput.style.height = 'auto'; // Reset textarea height
    UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;

    // Create AbortController and morph button
    activeAbortController = new AbortController();
    setProcessingState(true);

    let contextData = "";

    // PRIORITY 1: Recently uploaded file content (direct injection)
    // This ensures OCR text from images and full PDF content reaches the LLM
    if (lastUploadedContent) {
        contextData = `[FULL CONTENT FROM UPLOADED FILE: ${lastUploadedFilename}]\n${String(lastUploadedContent).slice(0, 6000)}\n\n`;
        // Keep it available for follow-up questions about the same file
        // Only clear if user starts a completely new topic (detected below)
        lastUploadedContent = null;
        lastUploadedFilename = null;
    }

    // PRIORITY 2: Full file context if a 3D node is clicked/selected
    if (!contextData && window.selectedNodeId && currentGraphData) {
        const activeNode = currentGraphData.nodes.find(n => n.id === window.selectedNodeId);
        if (activeNode && activeNode.content) {
            contextData = `[FULL FILE CONTENT FROM ${activeNode.label || 'Uploaded File'}]:\n${String(activeNode.content).slice(0, 6000)}\n\n`;
        }
    }

    // Generation modes (PPT/PDF/CSV/Visualize) are topic-generation, not
    // questions about the workspace — skip RAG so project code can't pollute
    // (e.g. a PPT on a generic topic was getting workspace Flask code injected).
    const isGenMode = activeGenMode && activeGenMode !== 'web';

    // NOTE: there is no PRIORITY-3 vector search here anymore. The backend's
    // assemble_brain_context already runs the SAME per-project semantic search
    // (sized to the hardware/model), so doing it here too doubled the injected
    // context (slow) and added a wasted round-trip. PRIORITY 1/2 (explicit
    // uploaded file / selected node) still flow through `context`.

    try {
        // Build the final question — modify if generation mode is active
        let finalQuestion = question;
        
        if (activeGenMode && activeGenMode !== 'json' && activeGenMode !== 'web') {
            const genInstructions = {
                pdf: `The user wants a detailed, well-structured report. Please provide comprehensive, thorough analysis with clear sections, headings (use markdown ##), bullet points, and data-driven insights. Write as if creating a professional document. Be exhaustive and detailed.\n\nUser request: ${question}`,
                ppt: `The user wants presentation-ready content for a ${UI.pptSlideCount.value}-slide PowerPoint. Please structure your response with EXACTLY ${UI.pptSlideCount.value} clearly separated sections using ## headings. Each section will become one slide.\n\nRules:\n- Start with a clear ## Title for each section\n- Use 3-5 bullet points per section\n- Include relevant data visualizations using <CHART> tags where appropriate\n- Keep each section concise but informative\n- Separate sections clearly with ## headings\n- Cover the topic comprehensively across all ${UI.pptSlideCount.value} sections\n\nUser request: ${question}`,
                csv: (() => {
                    // Column count from the dedicated input (falls back to a count
                    // named in the prompt, else 20).
                    const inputEl = document.getElementById('csv-col-count');
                    const colMatch = question.match(/(\d+)\s*(?:\+|or more\s*)?columns?/i);
                    const cols = Math.min(parseInt((inputEl && inputEl.value) || (colMatch && colMatch[1]) || 20) || 20, 200);
                    return `The user wants a tabular dataset they can open as a spreadsheet. Respond with ONE GitHub-style Markdown table and NOTHING else (no prose, no second table, before or after). Rules:\n- The table MUST have EXACTLY ${cols} columns with distinct, meaningful, relevant headers (do not pad with blank columns).\n- First row = column headers, second row = the |---|---| separator, then one record per row.\n- EVERY data row MUST have EXACTLY ${cols} | -separated columns.\n- Keep values simple: do NOT put a comma inside any single cell.\n- Provide at least 15 rows of realistic, varied data.\n\nUser request: ${question}`;
                })()
            };
            finalQuestion = genInstructions[activeGenMode] || question;
        }

        // Web Search Mode: fetch real search results and inject as context
        let webContext = '';
        if (activeGenMode === 'web') {
            try {
                const searchResp = await fetch('/api/web-search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ query: question }),
                    signal: activeAbortController.signal
                });
                if (searchResp.ok) {
                    const searchData = await searchResp.json();
                    if (searchData.results && searchData.results.length > 0) {
                        webContext = '\n\n--- WEB SEARCH RESULTS ---\n' + searchData.results.map((r, i) => 
                            `[${i+1}] ${r.title}\n${r.body}\nSource: ${r.href}`
                        ).join('\n\n');
                    }
                }
            } catch(e) {
                console.warn('Web search failed:', e);
            }
            finalQuestion = `The user has requested a web search. Below are real search results from the internet. Please synthesize these results into a comprehensive, well-organized answer. Cite sources where relevant.\n\nUser query: ${question}${webContext}`;
        }

        // ==========================================
        // VISUALIZE / PREDICTIVE ROUTING
        // Only the dedicated 📈 Visualize chip routes here — plain chat (and the
        // CSV chip) is never hijacked by the words "visualize"/"forecast".
        // ==========================================
        if (activeGenMode === 'visualize') {
            const qlow = question.toLowerCase();
            const nums = (question.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
            const typeMatch = qlow.match(/\b(bar|line|pie|doughnut|donut|radar|scatter|polar\s?area|polararea)\b/);

            // No explicit numeric series → this is a SEMANTIC request ("data on
            // 'no rain' days as a pie chart"). Let the LLM produce a real, on-topic
            // <CHART>; it renders via the normal chat pipeline (formatted on done).
            if (nums.length < 3) {
                let t;
                if (typeMatch) {
                    t = typeMatch[1].replace(/\s/g, '');
                    if (t === 'donut') t = 'doughnut';
                    if (t === 'polararea') t = 'polarArea';
                } else {
                    // Smart default: pie for share/breakdown/distribution asks, else bar.
                    t = /\b(share|breakdown|distribution|proportion|percentage|split|composition)\b/.test(qlow) ? 'pie' : 'bar';
                }
                finalQuestion = `Produce a data visualization for the user's request. Output a brief one-line intro, then EXACTLY ONE <CHART> block with real, relevant labels and numeric values — no other commentary. Use chart type "${t}". Format:\n<CHART>\n{"type":"${t}","label":"Short title","labels":["A","B","C"],"data":[10,20,30]}\n</CHART>\n\nUser request: ${question}`;
                // fall through to the normal ws chat below.
            } else {
            // Explicit numeric series → run the predictive forecast.
            const matrix_data = nums;

            const predResp = await fetch('/api/predictive-analytics', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data_matrix: matrix_data, visualize_active: true }),
                signal: activeAbortController.signal
            });
            if (predResp.ok) {
                const predData = await predResp.json();
                if (!predData.error && Array.isArray(predData.chart_data)) {
                    // Turn the {x,y,type} coordinates into a Chart.js chart and
                    // render it through the normal <CHART> pipeline. Default to a
                    // line chart, but honor an explicit type in the user's prompt.
                    const labels = predData.chart_data.map(p => String(p.x));
                    const values = predData.chart_data.map(p => Number(p.y.toFixed(2)));
                    const cutoff = predData.chart_data.findIndex(p => p.type === 'forecast');
                    let chartType = typeMatch ? typeMatch[1].replace(/\s/g, '') : 'line';
                    if (chartType === 'donut') chartType = 'doughnut';
                    if (chartType === 'polararea') chartType = 'polarArea';
                    const chartConfig = {
                        type: chartType,
                        label: `Forecast${cutoff > 0 ? ` (history → next ${values.length - cutoff} steps)` : ''}`,
                        labels,
                        data: values
                    };
                    const block = `Predictive analysis complete — historical series with a 5-step forecast.\n<CHART>${JSON.stringify(chartConfig)}</CHART>`;
                    const rendered = formatChatMessage(block);
                    const aiHtml = `<div class="chat-msg ai">${rendered}</div>`;
                    UI.chatOutput.innerHTML += aiHtml;
                    UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;
                    initPendingCharts();
                    saveMessageToSession('ai', block, aiHtml);
                    setProcessingState(false);
                    activeGenMode = null;
                    document.querySelectorAll('.gen-chip').forEach(c => c.classList.remove('gen-chip-active'));
                    UI.chatInput.placeholder = 'Ask anything...';
                    return;
                }
            }
            // If prediction failed, fall through to a normal chat answer.
            }
        }

        // ==========================================
        // DEEP THINK AIRLLM QUEUE DISPATCH
        // ==========================================
        if (isDeepThinkActive && (activeGenMode === 'pdf' || activeGenMode === 'ppt' || activeGenMode === null)) {
            const tempDivId = 'dt-init-' + Math.random().toString(36).substr(2, 7);
            const dtHtml = `<div class="chat-msg ai" style="color:#a5b4fc; font-style:italic;" id="${tempDivId}">🚀 Deep Think Engine initialized. Offloading task to Async AirLLM Queue...</div>`;
            UI.chatOutput.innerHTML += dtHtml;
            UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;
            
            const submitResp = await fetch('/api/generate-deep-analysis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: finalQuestion,
                    model_repo: window.deepThinkModelRepo || "",
                    project_id: currentProjectId || "default"
                }),
                signal: activeAbortController.signal
            });
            
            const submitData = await submitResp.json();
            if (submitData.task_id) {
                const taskId = submitData.task_id;
                
                const initDiv = document.getElementById(tempDivId);
                if (initDiv) initDiv.id = `dt-status-${taskId}`;
                
                // UNLOCK THE CHAT BAR IMMEDIATELY
                setProcessingState(false);
                
                // FIRE AND FORGET POLLING
                const pollTask = async () => {
                    let active = true;
                    while (active) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        try {
                            const statusResp = await fetch(`/api/deep-analysis-status/${taskId}`);
                            const statusData = await statusResp.json();
                            
                            const statusDiv = document.getElementById(`dt-status-${taskId}`);
                            if (statusData.status === 'processing' && statusDiv) {
                                statusDiv.innerHTML = `⚙️ Deep Think Engine processing (Layer by Layer)... Progress: ${statusData.progress}%`;
                            } else if (statusData.status === 'completed') {
                                if (statusDiv) statusDiv.remove();
                                const formattedResponse = formatChatMessage(statusData.result);
                                const responseId = 'resp-' + Math.random().toString(36).substr(2, 7);
                                const aiHtml = `<div class="chat-msg ai" id="${responseId}">${formattedResponse}
                                    <div class="response-actions">
                                        <button class="response-action-btn" onclick="downloadResponseAsPdf('${responseId}')">📄 Download as PDF</button>
                                        <button class="response-action-btn" onclick="copyFullResponse('${responseId}')">📋 Copy All</button>
                                    </div>
                                </div>`;
                                
                                UI.chatOutput.innerHTML += aiHtml;
                                saveMessageToSession('ai', statusData.result, aiHtml);
                                UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;
                                initPendingCharts();
                                
                                if (activeGenMode) {
                                    await autoExportGeneration(statusData.result);
                                }
                                active = false;
                            } else if (statusData.status === 'error') {
                                if (statusDiv) statusDiv.innerHTML = `⚠️ Deep Think Error: ${statusData.result}`;
                                active = false;
                            }
                        } catch(e) { console.error(e); }
                    }
                };
                
                pollTask();
                return;
            }
        }

        // Wait until brainWs is connected
        if (!window.brainWs || window.brainWs.readyState !== WebSocket.OPEN) {
            throw new Error("Universal Brain WebSocket is not connected. Please refresh or try again in a moment.");
        }

        const payload = {
            interaction_mode: "ask",
            model: getEffectiveProvider(),
            api_key: (UI.keyInput.value || '').trim(),
            prompt: finalQuestion,
            context: contextData || "General Knowledge Query",
            ui_context: {},
            project_id: currentProjectId || "default",
            images: lastUploadedImageB64 ? [lastUploadedImageB64] : [],
            // Generation modes skip server-side RAG so a topic prompt stays clean.
            skip_context: isGenMode
        };
        // One-shot: the image rides along with this turn, then is cleared.
        lastUploadedImageB64 = null;

        window.brainWs.send(JSON.stringify(payload));

        // Polling loop to check if handleBrainMessage is done generating.
        // Stored on window so the stop button can clear it (otherwise it leaks
        // as a zombie poller across turns and wedges the chat).
        if (window.chatCheckDoneInterval) clearInterval(window.chatCheckDoneInterval);
        let hasStarted = false;
        const checkDone = setInterval(() => {
            if (window.activeResponseDiv !== null) {
                hasStarted = true;
            } else if (hasStarted && window.activeResponseDiv === null) {
                clearInterval(checkDone);
                window.chatCheckDoneInterval = null;
                setProcessingState(false);
                initPendingCharts();
                if (activeGenMode) {
                    // The answer is already persisted (raw) by handleBrainMessage's
                    // 'done' handler. Export from that same raw text — it still has
                    // the <CHART>/table/markdown source (DOM textContent would not).
                    const raw = window.lastAiRawResponse || '';
                    if (raw) autoExportGeneration(raw);
                    // Visualize is rendered inline (no file export) — clear the
                    // one-shot mode so the next message is a normal chat.
                    if (activeGenMode === 'visualize') {
                        activeGenMode = null;
                        document.querySelectorAll('.gen-chip').forEach(c => c.classList.remove('gen-chip-active'));
                        UI.chatInput.placeholder = 'Ask anything...';
                    }
                }
            }
        }, 500);
        window.chatCheckDoneInterval = checkDone;

    } catch (err) {
        if (err.name === 'AbortError') {
            // Handled by the stop button click — do nothing here
        } else {
            const errorHtml = `<div class="chat-msg ai" style="color:#ef4444;">⚠️ Connection failed: ${err.message}</div>`;
            UI.chatOutput.innerHTML += errorHtml;
            saveMessageToSession('ai', `Connection failed: ${err.message}`, errorHtml);
            UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;
        }
        setProcessingState(false);
    }
}

UI.chatSendBtn.addEventListener('click', executeAgentChat);

// Shift+Enter = new line, Enter = send
UI.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        executeAgentChat();
    }
});

// Auto-resize textarea as user types
UI.chatInput.addEventListener('input', () => {
    UI.chatInput.style.height = 'auto';
    UI.chatInput.style.height = Math.min(UI.chatInput.scrollHeight, 150) + 'px';
});

// Download single AI response as PDF
window.downloadResponseAsPdf = async function(responseId) {
    const element = document.getElementById(responseId);
    if (!element) return;

    // Get raw text (excluding action buttons)
    const clone = element.cloneNode(true);
    const actions = clone.querySelector('.response-actions');
    if (actions) actions.remove();
    const textContent = clone.innerText || clone.textContent;

    const session = chatSessions.find(s => s.id === currentSessionId);
    const project = projects.find(p => p.id === currentProjectId);

    try {
        const response = await fetch('/api/export-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: String(currentSessionId),
                projectName: project ? project.name : 'Cortex',
                sessionName: session ? (session.title || 'Response Export') : 'Response Export',
                modelUsed: getEffectiveProvider() || 'local',
                messages: [{ narrative: textContent, charts: [] }]
            })
        });

        if (!response.ok) throw new Error('PDF generation failed');

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cortex-response-${Date.now()}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        alert(`PDF Export Failed: ${err.message}`);
    }
};

// Copy full response text
window.copyFullResponse = function(responseId) {
    const element = document.getElementById(responseId);
    if (!element) return;

    const clone = element.cloneNode(true);
    const actions = clone.querySelector('.response-actions');
    if (actions) actions.remove();
    const text = clone.innerText || clone.textContent;

    navigator.clipboard.writeText(text).then(() => {
        const btn = element.querySelector('.response-action-btn:nth-child(2)');
        if (btn) {
            btn.textContent = '✓ Copied';
            setTimeout(() => { btn.textContent = '📋 Copy All'; }, 2000);
        }
    });
};

// Copy / edit a user message (buttons under each user bubble).
window.copyUserMsg = function(encoded) {
    navigator.clipboard.writeText(decodeURIComponent(encoded)).then(() => showGenToast('✅ Copied', 1200));
};
window.editUserMsg = function(encoded) {
    UI.chatInput.value = decodeURIComponent(encoded);
    UI.chatInput.style.height = 'auto';
    UI.chatInput.style.height = UI.chatInput.scrollHeight + 'px';
    UI.chatInput.focus();
};

// ==========================================
// 11. 3D Spatial Rendering Framework
// ==========================================
function renderUniverse(rawNodes, clusterTitles) {
    const formattedNodes = rawNodes.map(n => ({ ...n, fx: n.x * 6.0, fy: n.y * 6.0, fz: n.z * 6.0 }));
    const formattedLinks = [];
    const clusterMap = {};

    formattedNodes.forEach(n => {
        if (!clusterMap[n.cluster_id]) clusterMap[n.cluster_id] = [];
        clusterMap[n.cluster_id].push(n.id);
    });

    Object.values(clusterMap).forEach(arr => {
        for (let i = 0; i < arr.length - 1; i++) formattedLinks.push({ source: arr[i], target: arr[i + 1] });
    });

    UI.canvas.innerHTML = "";

    MindGraph = ForceGraph3D({ rendererConfig: { antialias: true, alpha: true, powerPreference: 'high-performance' } })(UI.canvas)
        .graphData({ nodes: formattedNodes, links: formattedLinks })
        .backgroundColor(document.documentElement.getAttribute('data-theme') === 'light' ? '#f5f5f5' : '#0a0a0a')
        .nodeLabel(n => {
            const t = (clusterTitles && clusterTitles[String(n.cluster_id)]) ? clusterTitles[String(n.cluster_id)] : "Topic...";
            const isLight = document.documentElement.getAttribute('data-theme') === 'light';
            const tooltipBg = isLight ? 'rgba(255,255,255,0.95)' : 'rgba(18,18,18,0.95)';
            const tooltipBorder = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
            const tooltipSubtet = isLight ? '#666' : '#8e8e8e';
            return `<div style="background:${tooltipBg}; border:1px solid ${tooltipBorder}; padding:10px; border-radius:8px;"><strong style="color:${getClusterColor(n.cluster_id)}">${t}</strong><br><span style="color:${tooltipSubtet};font-size:0.85rem;">📄 ${n.source_file}</span></div>`;
        })
        .nodeColor(n => getClusterColor(n.cluster_id))
        .nodeVal(3).linkOpacity(0.15).linkWidth(1)
        .linkColor(l => {
            const s = formattedNodes.find(n => n.id === l.source.id || n.id === l.source);
            return s ? getClusterColor(s.cluster_id) : '#ffffff';
        })
        .onNodeClick(n => {
            window.selectedNodeId = n.id;
            const distRatio = 1 + 80 / (Math.hypot(n.x, n.y, n.z) || 0.001);
            MindGraph.cameraPosition({ x: n.fx * distRatio, y: n.fy * distRatio, z: n.fz * distRatio }, n, 1500);

            hideWelcomeState();
            const html = `<div class="chat-msg ai" style="color:var(--accent);font-size:0.85rem;"><i>* Context linked to: ${n.source_file} *</i></div>`;
            UI.chatOutput.innerHTML += html;
            saveMessageToSession('system', 'linked', html);
            UI.chatOutput.scrollTop = UI.chatOutput.scrollHeight;
        });
    
    // Improve rendering quality for Chrome (Safari handles this natively via Metal)
    try {
        MindGraph.renderer().setPixelRatio(window.devicePixelRatio || 1);
    } catch(e) { console.warn('Could not set pixel ratio:', e); }
}

// ==========================================
// 12. Quote-Reply System (Select AI Text → Reply)
// ==========================================
(function initQuoteReply() {
    let quoteBtn = null;

    function createQuoteBtn() {
        const btn = document.createElement('button');
        btn.className = 'quote-reply-btn';
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg> Reply';
        btn.style.display = 'none';
        document.body.appendChild(btn);
        return btn;
    }

    quoteBtn = createQuoteBtn();

    function getSelectedTextInAI() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) return null;

        // Check if selection is within an AI message
        const anchorNode = sel.anchorNode;
        const focusNode = sel.focusNode;
        if (!anchorNode || !focusNode) return null;

        const aiMsg = anchorNode.parentElement?.closest('.chat-msg.ai') || 
                      focusNode.parentElement?.closest('.chat-msg.ai');
        if (!aiMsg) return null;

        return sel.toString().trim();
    }

    document.addEventListener('mouseup', (e) => {
        // Small delay so selection finalizes
        setTimeout(() => {
            // Don't trigger if clicking the quote button itself
            if (e.target.closest('.quote-reply-btn')) return;

            const selectedText = getSelectedTextInAI();
            if (!selectedText) {
                quoteBtn.style.display = 'none';
                return;
            }

            // Position the button near the mouse
            const x = Math.min(e.clientX + 10, window.innerWidth - 120);
            const y = Math.max(e.clientY - 40, 10);
            quoteBtn.style.left = x + 'px';
            quoteBtn.style.top = y + 'px';
            quoteBtn.style.display = 'flex';

            // Store the text for the click handler
            quoteBtn.dataset.quoteText = selectedText;
        }, 10);
    });

    quoteBtn.addEventListener('click', () => {
        const text = quoteBtn.dataset.quoteText;
        if (!text) return;

        // Format as a blockquote and insert into chat input
        const quotedLines = text.split('\n').map(line => `> ${line}`).join('\n');
        const currentInput = UI.chatInput.value;
        const prefix = currentInput ? currentInput + '\n\n' : '';
        UI.chatInput.value = prefix + quotedLines + '\n\n';

        // Auto-resize textarea
        UI.chatInput.style.height = 'auto';
        UI.chatInput.style.height = Math.min(UI.chatInput.scrollHeight, 150) + 'px';
        UI.chatInput.focus();

        // Place cursor at the end
        UI.chatInput.selectionStart = UI.chatInput.value.length;
        UI.chatInput.selectionEnd = UI.chatInput.value.length;

        // Clear selection and hide button
        window.getSelection().removeAllRanges();
        quoteBtn.style.display = 'none';
    });

    // Hide on scroll or click elsewhere
    document.addEventListener('mousedown', (e) => {
        if (!e.target.closest('.quote-reply-btn')) {
            quoteBtn.style.display = 'none';
        }
    });
})();

// ==========================================
// 13. Voice Recording Integration (Phase 5)
// ==========================================
let mediaRecorder;
let audioChunks = [];
const chatMicBtn = document.getElementById('chat-mic-btn');

let isRecording = false;
let originalInputText = "";

if (chatMicBtn) {
    chatMicBtn.addEventListener('click', async () => {
        if (isRecording && mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            isRecording = false;
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Prefer webm/opus, fallback to mp4. Safari defaults to mp4 without timeslice causing moov atom drops.
            let options = {};
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                options = { mimeType: 'audio/webm;codecs=opus' };
            } else if (MediaRecorder.isTypeSupported('audio/webm')) {
                options = { mimeType: 'audio/webm' };
            } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
                options = { mimeType: 'audio/mp4' };
            }
            
            mediaRecorder = new MediaRecorder(stream, options);
            audioChunks = [];
            
            mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) {
                    audioChunks.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                if (audioChunks.length === 0) {
                    console.error("No audio data recorded. Please hold the button longer.");
                    chatMicBtn.classList.remove('recording');
                    stream.getTracks().forEach(track => track.stop());
                    UI.chatInput.disabled = false;
                    UI.chatInput.value = originalInputText;
                    return;
                }
                
                const actualMimeType = mediaRecorder.mimeType || options.mimeType || 'audio/webm';
                let extension = 'webm';
                if (actualMimeType.includes('mp4')) extension = 'mp4';
                else if (actualMimeType.includes('ogg')) extension = 'ogg';
                else if (actualMimeType.includes('wav')) extension = 'wav';
                
                const audioBlob = new Blob(audioChunks, { type: actualMimeType });
                const formData = new FormData();
                formData.append("audio", audioBlob, `voice.${extension}`);
                
                chatMicBtn.classList.remove('recording');
                const originalTitle = chatMicBtn.title;
                chatMicBtn.title = "Transcribing...";
                chatMicBtn.style.opacity = '0.5';
                
                // Update chat input to show transcribing status
                UI.chatInput.value = (originalInputText ? originalInputText + ' ' : '') + "⏳ Transcribing...";
                
                try {
                    const response = await fetch('/api/voice/transcribe', {
                        method: 'POST',
                        body: formData
                    });
                    const data = await response.json();
                    
                    UI.chatInput.disabled = false;
                    
                    if (data.text && !data.error) {
                        UI.chatInput.value = (originalInputText ? originalInputText + ' ' : '') + data.text;
                        UI.chatInput.style.height = 'auto';
                        UI.chatInput.style.height = Math.min(UI.chatInput.scrollHeight, 150) + 'px';
                    } else if (data.error) {
                        console.error("Voice Error:", data.error);
                        UI.chatInput.value = originalInputText;
                        alert("Transcription failed: " + data.error);
                    }
                } catch (err) {
                    console.error("Transcription error:", err);
                    UI.chatInput.disabled = false;
                    UI.chatInput.value = originalInputText;
                } finally {
                    chatMicBtn.title = originalTitle;
                    chatMicBtn.style.opacity = '1';
                    stream.getTracks().forEach(track => track.stop());
                }
            };

            // Start with a timeslice of 1000ms. This forces Safari to write the 'moov' atom 
            // in the first chunk of the fragmented mp4, preventing ffmpeg corruption errors.
            mediaRecorder.start(1000);
            isRecording = true;
            chatMicBtn.classList.add('recording');
            
            // Add live visual feedback to chat bar
            originalInputText = UI.chatInput.value.trim();
            UI.chatInput.disabled = true;
            UI.chatInput.value = (originalInputText ? originalInputText + ' ' : '') + "🎙️ Listening...";
        } catch (err) {
            console.error("Microphone access denied:", err);
            alert("Please allow microphone access to dictate.");
            isRecording = false;
            if (typeof originalInputText !== 'undefined') {
                UI.chatInput.disabled = false;
                UI.chatInput.value = originalInputText;
            }
        }
    });
}

// ==========================================
// 14. Unified Settings Modal (Phase 5)
// ==========================================
const settingsModalOverlay = document.getElementById('settings-modal');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const tabBtns = document.querySelectorAll('.settings-tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

if (settingsCloseBtn) {
    // Close settings
    settingsCloseBtn.addEventListener('click', () => {
        settingsModalOverlay.classList.add('hidden');
    });

    // Override settings icon click in header
    document.getElementById('settings-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        settingsModalOverlay.classList.remove('hidden');
        loadMemoryLedger();
        loadSystemStats();
    });

    // Tab switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.add('hidden'));

            btn.classList.add('active');
            const tabId = btn.getAttribute('data-tab');
            document.getElementById(`tab-${tabId}`).classList.remove('hidden');
        });
    });

    // Purge Regional Indexes — clears the GraphRAG vector index + diff cache
    // (rebuildable by re-mapping). Does NOT touch the Memory Ledger, Notes &
    // Tasks, API keys, theme, or chat history. Two-click confirm guard.
    const purgeBtn = document.getElementById('purge-index-btn');
    if (purgeBtn) {
        const resetPurgeBtn = () => {
            purgeBtn._armed = false; purgeBtn.disabled = false;
            purgeBtn.classList.remove('confirming');
            purgeBtn.textContent = 'Purge Regional Indexes';
        };
        purgeBtn.addEventListener('click', async () => {
            if (!purgeBtn._armed) {
                purgeBtn._armed = true;
                purgeBtn.classList.add('confirming');
                purgeBtn.textContent = 'Confirm purge?';
                clearTimeout(purgeBtn._disarm);
                purgeBtn._disarm = setTimeout(resetPurgeBtn, 4000);
                return;
            }
            clearTimeout(purgeBtn._disarm);
            purgeBtn._armed = false; purgeBtn.disabled = true;
            purgeBtn.textContent = 'Purging…';
            try {
                const res = await fetch('/api/system/purge-index', { method: 'POST' });
                const data = await res.json();
                if (data && data.status === 'purged') {
                    loadSystemStats();
                    if (window.showToast) window.showToast('Regional indexes purged — re-map a project to rebuild.', 'success');
                } else {
                    if (window.showToast) window.showToast('Purge failed.', 'error');
                }
            } catch (e) {
                if (window.showToast) window.showToast('Purge failed: ' + e.message, 'error');
            } finally {
                resetPurgeBtn();
            }
        });
    }

    // Memory API Calls
    async function loadMemoryLedger() {
        try {
            const res = await fetch('/api/memory/get');
            const data = await res.json();
            const tableBody = document.querySelector('#memory-table tbody');
            tableBody.innerHTML = '';
            
            if (data.memories && data.memories.length > 0) {
                data.memories.forEach(mem => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td>${mem.memory}</td>
                        <td><button class="memory-action-btn" onclick="deleteMemory('${mem.id}')">✕</button></td>
                    `;
                    tableBody.appendChild(tr);
                });
            } else {
                tableBody.innerHTML = '<tr><td colspan="2" style="text-align:center;color:var(--text-muted)">No memories extracted yet.</td></tr>';
            }
        } catch(e) { console.error(e); }
    }
    // Expose so out-of-closure handlers (e.g. the Import Vault button, which is
    // wired at top-level scope) can refresh the ledger without a page reload.
    window.loadMemoryLedger = loadMemoryLedger;

    async function loadSystemStats() {
        try {
            const res = await fetch('/api/system/stats');
            const data = await res.json();
            document.getElementById('stat-sqlite').innerText = data.sqlite_db_size_mb + ' MB';
            document.getElementById('stat-chroma').innerText = data.chroma_db_size_mb + ' MB';
            document.getElementById('stat-nodes').innerText = data.vector_nodes;
        } catch(e) { console.error(e); }
    }

    window.deleteMemory = async function(id) {
        await fetch('/api/memory/delete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({memory_id: id})
        });
        loadMemoryLedger();
    };

    document.getElementById('manual-memory-add-btn').addEventListener('click', async () => {
        const input = document.getElementById('manual-memory-input');
        const content = input.value.trim();
        if (!content) return;
        
        await fetch('/api/memory/add', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({content: content})
        });
        input.value = '';
        loadMemoryLedger();
    });

    const exportBtn = document.getElementById('memory-export-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/memory/get');
                const data = await res.json();
                const memories = data.memories || [];
                
                if (memories.length === 0) {
                    alert("No memories to export.");
                    return;
                }

                // Format as a text file line-by-line for easy reading/porting
                let capsuleText = "--- CORTEX MEMORY CAPSULE ---\n";
                capsuleText += `Exported: ${new Date().toISOString()}\n\n`;
                memories.forEach((m, i) => {
                    capsuleText += `${i + 1}. ${m.memory}\n`;
                });
                
                const blob = new Blob([capsuleText], {type: 'text/plain;charset=utf-8'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `memory-capsule-${new Date().toISOString().split('T')[0]}.tt`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (err) {
                console.error("Export failed", err);
                alert("Failed to export memory capsule.");
            }
        });
    }
}

// ==========================================
// 15. Portable Memory Capsule (Import Vault)
// ==========================================
const UNIVERSAL_EXPORT_PROMPT = `You are executing a structured user-profile data migration. Your task is to audit our entire conversation history, your active memory storage system, and custom instruction settings to compile a comprehensive, high-fidelity profile of me.

To ensure this profile can be seamlessly ingested into a local vector database without text-cleaning pipelines, you must strictly adhere to the following formatting and linguistic constraints:

1. ZERO PRONOUNS: Never use first-person pronouns (I, my, me, mine) or second-person pronouns (you, your, yours). Always refer to the individual as "the user" or use passive/neutral phrasing.
2. CHRONOLOGICAL EVIDENCE LOGGING: Every individual atomic fact must be explicitly anchored by chronological or context-based evidence. Format each atomic line exactly as follows:
   * [YYYY-MM-DD] (or [Unknown] if undated) - Fact description. Evidence: Verbatim quote from chat history or stored memory block justifying this entry.

Categories to Extract (Output strictly in this order):

## 1. Demographics & Identity
* Technical background, name, educational status, specialization, institutional affiliation, general location, and hardware setup details.

## 2. Instructions & Core Guardrails
* Overriding behavioral constraints, explicitly requested tones, formatting rules, coding style enforcement (e.g.x, specific colors, styling elements, tab/space choices), "always do X", and "never do Y" mandates. Only pull from active permanent instructions or highly recurring behavioral corrections.

## 3. Persistent Interests & Working Tastes
* Long-term, active engagements, personal learning tracks, domain deep-dives, preferred technology stacks, libraries, and architectural paradigms.

## 4. Active Projects & System Architecture
* Individual entries for systems built or currently being committed to. For each project, denote its core purpose, technical stack, current implementation phase, and key design constraints. Use the project name as the leading words of the entry.

## 5. Relationships & Context Entities
* Verified, sustained interactions with professional collaborators, mentors, specific institutional figures, local directory structures, or regional references.

Output Delivery Format:
- Wrap the entire categorized profile inside a single, clean markdown code block for instantaneous one-click copying.
- Do not include any preambles, introductory sentences, polite padding, or conversational filler before the block.
- As the absolute final line of text outside the code block, complete the exact sentence: "Imported from: <Name>" (where <Name> is ChatGPT, Claude, Gemini, Grok, etc.x, depending on your platform).`;

const promptDisplay = document.getElementById('import-prompt-display');
const copyPromptBtn = document.getElementById('copy-prompt-btn');
const importTextarea = document.getElementById('import-memory-textarea');
const submitImportBtn = document.getElementById('submit-import-btn');

if (promptDisplay) {
    promptDisplay.textContent = UNIVERSAL_EXPORT_PROMPT;

    // 1. Copy Button Logic
    copyPromptBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(UNIVERSAL_EXPORT_PROMPT);
            const btnText = copyPromptBtn.querySelector('.btn-text');
            const originalText = btnText.textContent;
            btnText.textContent = 'Copied!';
            copyPromptBtn.style.color = '#10b981'; // Green hue
            copyPromptBtn.style.borderColor = '#10b981';
            
            setTimeout(() => {
                btnText.textContent = originalText;
                copyPromptBtn.style.color = '';
                copyPromptBtn.style.borderColor = '';
            }, 2000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    });

    // 2. Textarea Listener
    importTextarea.addEventListener('input', () => {
        if (importTextarea.value.trim().length > 0) {
            submitImportBtn.removeAttribute('disabled');
        } else {
            submitImportBtn.setAttribute('disabled', 'true');
        }
    });

    // 3. Add Memory Submission
    submitImportBtn.addEventListener('click', async () => {
        const payload = importTextarea.value.trim();
        if (!payload) return;

        const originalText = submitImportBtn.textContent;
        submitImportBtn.textContent = 'Parsing...';
        submitImportBtn.setAttribute('disabled', 'true');

        try {
            // Real fetch call to process the imported memory capsule
            await fetch('/api/memory/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload: payload })
            });
            
            importTextarea.value = '';
            submitImportBtn.textContent = 'Added!';
            submitImportBtn.style.background = '#10b981';

            // Reload the ledger immediately so imported facts show without a
            // page refresh. loadMemoryLedger lives in another closure, so it's
            // reached via the window global exposed at its definition.
            if (typeof window.loadMemoryLedger === 'function') {
                await window.loadMemoryLedger();
            }

            setTimeout(() => {
                submitImportBtn.textContent = 'Add memory';
                submitImportBtn.style.background = '';
                submitImportBtn.setAttribute('disabled', 'true');
            }, 2000);
        } catch (error) {
            console.error('Import failed', error);
            submitImportBtn.textContent = 'Error';
            setTimeout(() => {
                submitImportBtn.textContent = originalText;
                submitImportBtn.removeAttribute('disabled');
            }, 2000);
        }
    });
}
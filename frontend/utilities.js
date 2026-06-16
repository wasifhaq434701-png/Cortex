/* ==========================================================================
   Phase 8 — The Unified Utilities Studio (4th surface).
   Classic (non-module) script: top-level `window.*` functions become globals,
   matching the rest of the frontend. Reuses window.showToast.

   Four canvases share one left rail:
     tasks    — Notes & Tasks (+ reminder daemon)
     comms    — Email & Calendar (draft-only, OS-aware)
     cookbook — Hardware-aware model serving
     compare  — Blind model comparison
   Each canvas lazy-inits on first activation.
   ========================================================================== */
(function () {
    'use strict';

    const toast = (m, t) => (window.showToast ? window.showToast(m, t) : console.log('[util]', m));
    const inited = { tasks: false, comms: false };
    let railWired = false;
    let bootStarted = false;

    // Entry point — called by switchSurface('utilities').
    window.initUtilitiesStudio = function () {
        wireRail();
        // Default to the Tasks canvas on first open.
        if (!bootStarted) { bootStarted = true; activateCanvas('tasks'); }
    };

    // ---- Tool modal helpers (Cookbook / Compare live in the chat sidebar) ----
    function openToolModal(id) {
        const o = document.getElementById(id);
        if (o) o.classList.remove('hidden');
    }
    function closeToolModal(id) {
        const o = document.getElementById(id);
        if (o) o.classList.add('hidden');
    }
    // Wire sidebar launchers + modal close/overlay-click once the DOM is ready.
    function wireToolModals() {
        const cb = document.getElementById('open-cookbook-btn');
        const cmp = document.getElementById('open-compare-btn');
        if (cb) cb.addEventListener('click', () => window.openModelCookbook());
        if (cmp) cmp.addEventListener('click', () => window.openModelCompare());
        document.querySelectorAll('[data-close-tool]').forEach(b =>
            b.addEventListener('click', () => closeToolModal(b.getAttribute('data-close-tool'))));
        document.querySelectorAll('.tool-modal-overlay').forEach(o =>
            o.addEventListener('click', (e) => { if (e.target === o) closeToolModal(o.id); }));
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireToolModals);
    else wireToolModals();

    function wireRail() {
        if (railWired) return;
        const rail = document.getElementById('util-rail');
        if (!rail) return;
        rail.querySelectorAll('.util-tab').forEach(btn => {
            btn.addEventListener('click', () => activateCanvas(btn.getAttribute('data-util')));
        });
        railWired = true;
    }

    function activateCanvas(name) {
        document.querySelectorAll('.util-tab').forEach(b =>
            b.classList.toggle('active', b.getAttribute('data-util') === name));
        document.querySelectorAll('.util-canvas').forEach(c =>
            c.classList.toggle('hidden', c.getAttribute('data-canvas') !== name));
        if (!inited[name]) {
            inited[name] = true;
            if (name === 'tasks') initTasksCanvas();
            else if (name === 'comms') initCommsCanvas();
        } else {
            // Refresh dynamic canvases on re-entry.
            if (name === 'tasks') loadTasks();
        }
    }

    // ======================================================================
    // Part A — Notes & Tasks canvas
    // ======================================================================
    const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    function initTasksCanvas() {
        const el = document.getElementById('util-canvas-tasks');
        if (!el) return;
        el.innerHTML = `
          <div class="util-pane-head">
            <h2>🗒️ Notes &amp; Tasks</h2>
            <span class="util-next-chip" id="tasks-next-chip"></span>
          </div>
          <div class="util-lanes">
            <div class="util-lane" data-lane="note">
              <div class="util-lane-head"><span>📝 Notes</span>
                <button class="util-add" data-add="note">+ Note</button></div>
              <div class="util-lane-body" id="lane-note"></div>
            </div>
            <div class="util-lane" data-lane="task">
              <div class="util-lane-head"><span>✅ Tasks</span>
                <button class="util-add" data-add="task">+ Task</button></div>
              <div class="util-lane-body" id="lane-task"></div>
            </div>
            <div class="util-lane" data-lane="reminder">
              <div class="util-lane-head"><span>⏰ Reminders</span>
                <button class="util-add" data-add="reminder">+ Reminder</button></div>
              <div class="util-lane-body" id="lane-reminder"></div>
            </div>
          </div>
          <!-- Inline add forms (hidden until + clicked) -->
          <div class="util-modal-overlay hidden" id="task-add-overlay">
            <div class="util-modal" id="task-add-modal"></div>
          </div>`;
        el.querySelectorAll('.util-add').forEach(b =>
            b.addEventListener('click', () => openAddForm(b.getAttribute('data-add'))));
        loadTasks();
    }

    async function loadTasks() {
        try {
            const res = await fetch('/api/tasks');
            const data = await res.json();
            const items = (data && data.tasks) || [];
            renderLane('note', items.filter(i => i.kind === 'note'));
            renderLane('task', items.filter(i => i.kind === 'task'));
            renderLane('reminder', items.filter(i => i.kind === 'reminder'));
            updateNextChip(items.filter(i => i.kind === 'reminder'));
        } catch (e) { toast('Failed to load tasks: ' + e.message, 'error'); }
    }

    function renderLane(kind, items) {
        const lane = document.getElementById('lane-' + kind);
        if (!lane) return;
        if (!items.length) { lane.innerHTML = `<div class="util-empty">Nothing yet.</div>`; return; }
        lane.innerHTML = items.map(it => cardHtml(kind, it)).join('');
        lane.querySelectorAll('[data-toggle]').forEach(c =>
            c.addEventListener('change', () => toggleDone(c.getAttribute('data-toggle'), c.checked)));
        lane.querySelectorAll('[data-del]').forEach(b =>
            b.addEventListener('click', () => delTask(b.getAttribute('data-del'))));
    }

    function cardHtml(kind, it) {
        if (kind === 'note') {
            return `<div class="util-card">
                <div class="util-card-title">${esc(it.title)}</div>
                <div class="util-card-body">${esc(it.body)}</div>
                <button class="util-card-del" data-del="${it.id}" title="Delete">×</button>
            </div>`;
        }
        if (kind === 'task') {
            return `<div class="util-card util-task ${it.done ? 'done' : ''}">
                <label><input type="checkbox" data-toggle="${it.id}" ${it.done ? 'checked' : ''}/>
                <span class="util-card-title">${esc(it.title)}</span></label>
                <button class="util-card-del" data-del="${it.id}" title="Delete">×</button>
            </div>`;
        }
        // reminder
        const when = it.cron ? ('⟳ ' + esc(it.cron))
            : (it.due_at ? new Date(it.due_at * 1000).toLocaleString() : 'no time set');
        const fired = it.fired ? ' fired' : '';
        return `<div class="util-card util-reminder${fired}">
            <div class="util-card-title">${esc(it.title)}</div>
            <div class="util-card-when">${when}${it.fired ? ' · ✓ fired' : ''}</div>
            <button class="util-card-del" data-del="${it.id}" title="Delete">×</button>
        </div>`;
    }

    function updateNextChip(reminders) {
        const chip = document.getElementById('tasks-next-chip');
        if (!chip) return;
        const upcoming = reminders
            .filter(r => !r.fired && r.due_at && r.due_at * 1000 > Date.now())
            .sort((a, b) => a.due_at - b.due_at);
        chip.textContent = upcoming.length
            ? ('⏰ next: ' + new Date(upcoming[0].due_at * 1000).toLocaleString())
            : '';
    }

    function openAddForm(kind) {
        const overlay = document.getElementById('task-add-overlay');
        const modal = document.getElementById('task-add-modal');
        if (!overlay || !modal) return;
        const titleLabel = kind === 'note' ? 'Note title' : kind === 'task' ? 'Task' : 'Reminder';
        let extra = '';
        if (kind === 'note') {
            extra = `<textarea id="taf-body" rows="4" placeholder="Note body…"></textarea>`;
        } else if (kind === 'reminder') {
            extra = `
              <div class="taf-row">
                <label>When <input type="datetime-local" id="taf-due"/></label>
              </div>
              <div class="taf-row">
                <label>Or repeat (cron) <input type="text" id="taf-cron" placeholder="*/2 * * * *"/></label>
              </div>
              <p class="taf-hint">Cron is "min hour day-of-month month day-of-week". Leave blank for a one-time reminder.</p>`;
        }
        modal.innerHTML = `
          <h3>Add ${titleLabel}</h3>
          <input type="text" id="taf-title" placeholder="${titleLabel}…" autofocus/>
          ${extra}
          <div class="taf-actions">
            <button class="taf-cancel">Cancel</button>
            <button class="taf-save">Add</button>
          </div>`;
        overlay.classList.remove('hidden');
        const titleInput = modal.querySelector('#taf-title');
        titleInput && titleInput.focus();
        modal.querySelector('.taf-cancel').onclick = () => overlay.classList.add('hidden');
        overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add('hidden'); };
        modal.querySelector('.taf-save').onclick = () => saveAdd(kind, overlay, modal);
    }

    async function saveAdd(kind, overlay, modal) {
        const title = (modal.querySelector('#taf-title') || {}).value || '';
        if (!title.trim()) { toast('Give it a title first.', 'info'); return; }
        const payload = { kind, title: title.trim() };
        if (kind === 'note') payload.body = (modal.querySelector('#taf-body') || {}).value || '';
        if (kind === 'reminder') {
            const cron = (modal.querySelector('#taf-cron') || {}).value.trim();
            const due = (modal.querySelector('#taf-due') || {}).value;
            if (cron) payload.cron = cron;
            else if (due) payload.due_at = new Date(due).getTime() / 1000;
            else { toast('Pick a time or a cron schedule.', 'info'); return; }
        }
        try {
            const res = await fetch('/api/tasks', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            overlay.classList.add('hidden');
            loadTasks();
        } catch (e) { toast('Add failed: ' + e.message, 'error'); }
    }

    async function toggleDone(id, done) {
        try {
            await fetch('/api/tasks/' + id, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ done })
            });
            loadTasks();
        } catch (e) { toast('Update failed: ' + e.message, 'error'); }
    }

    async function delTask(id) {
        try {
            await fetch('/api/tasks/' + id, { method: 'DELETE' });
            loadTasks();
        } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
    }

    // ======================================================================
    // Parts B / C / D — implemented in their own build steps.
    // ======================================================================
    // ======================================================================
    // Part B — Email & Calendar canvas (draft-only, OS-aware)
    // ======================================================================
    let commsProviders = [];
    let commsPreview = null;   // last parsed { kind, fields }

    async function initCommsCanvas() {
        const el = document.getElementById('util-canvas-comms');
        if (!el) return;
        el.innerHTML = `
          <div class="util-pane-head"><h2>✉️ Email &amp; Calendar</h2>
            <label class="util-active-toggle"><input type="checkbox" id="comms-active" checked/> Active</label>
          </div>
          <div class="comms-intent">
            <div class="comms-intent-row">
              <select id="comms-kind">
                <option value="mail">📧 Email</option>
                <option value="event">📅 Calendar event</option>
              </select>
              <select id="comms-provider"></select>
            </div>
            <textarea id="comms-bar" rows="2"
              placeholder="Tell me what to draft — e.g. “Draft a summary of my weekly coding updates and drop it into Mail”"></textarea>
            <button id="comms-parse" class="comms-go">Draft it →</button>
          </div>
          <div class="comms-preview hidden" id="comms-preview"></div>`;
        // Populate providers (OS-aware; remember last choice).
        try {
            const res = await fetch('/api/comms/providers');
            const data = await res.json();
            commsProviders = data.providers || ['gmail'];
        } catch (_) { commsProviders = ['gmail']; }
        const labels = { apple_mail: 'Apple Mail', outlook: 'Outlook', gmail: 'Gmail' };
        const sel = el.querySelector('#comms-provider');
        const saved = localStorage.getItem('cortex_comms_provider');
        sel.innerHTML = commsProviders.map(p =>
            `<option value="${p}" ${p === saved ? 'selected' : ''}>${labels[p] || p}</option>`).join('');
        sel.addEventListener('change', () => localStorage.setItem('cortex_comms_provider', sel.value));
        el.querySelector('#comms-parse').addEventListener('click', () => parseIntent(el));
    }

    async function parseIntent(el) {
        const active = el.querySelector('#comms-active');
        if (active && !active.checked) { toast('Email & Calendar is set to inactive.', 'info'); return; }
        const text = el.querySelector('#comms-bar').value.trim();
        const kind = el.querySelector('#comms-kind').value;
        if (!text) { toast('Type what you want to draft first.', 'info'); return; }
        const btn = el.querySelector('#comms-parse');
        btn.disabled = true; btn.textContent = 'Drafting…';
        try {
            const res = await fetch('/api/comms/parse', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, kind })
            });
            const data = await res.json();
            if (data.status !== 'success') throw new Error(data.message || 'parse failed');
            commsPreview = { kind, fields: data.fields || {} };
            renderPreview(el);
        } catch (e) { toast('Draft failed: ' + e.message, 'error'); }
        finally { btn.disabled = false; btn.textContent = 'Draft it →'; }
    }

    function renderPreview(el) {
        const box = el.querySelector('#comms-preview');
        const provider = el.querySelector('#comms-provider').value;
        const labels = { apple_mail: 'Apple Mail', outlook: 'Outlook', gmail: 'Gmail' };
        const f = commsPreview.fields;
        let rows;
        if (commsPreview.kind === 'mail') {
            rows = `
              <label>To <input type="text" id="cp-to" value="${esc(f.to || '')}" placeholder="recipient@example.com"/></label>
              <label>Subject <input type="text" id="cp-subject" value="${esc(f.subject || '')}"/></label>
              <label>Body <textarea id="cp-body" rows="14">${esc(f.body || '')}</textarea></label>`;
        } else {
            rows = `
              <label>Title <input type="text" id="cp-subject" value="${esc(f.title || f.subject || '')}"/></label>
              <div class="comms-card-grid">
                <label>Start <input type="datetime-local" id="cp-start" value="${esc((f.start || '').slice(0,16))}"/></label>
                <label>End <input type="datetime-local" id="cp-end" value="${esc((f.end || '').slice(0,16))}"/></label>
              </div>
              <label>Location <input type="text" id="cp-location" value="${esc(f.location || '')}"/></label>
              <label>Details <textarea id="cp-body" rows="10">${esc(f.body || '')}</textarea></label>`;
        }
        box.innerHTML = `
          <div class="comms-card">
            <div class="comms-card-head">📝 Draft preview — review, then open in <b>${labels[provider] || provider}</b></div>
            ${rows}
            <div class="comms-card-actions">
              <span class="comms-safe">🔒 Draft-only — nothing is sent until you press send in ${labels[provider] || provider}.</span>
              <button id="comms-open" class="comms-go">Open draft →</button>
            </div>
          </div>`;
        box.classList.remove('hidden');
        box.querySelector('#comms-open').addEventListener('click', () => openDraft(el, provider));
    }

    async function openDraft(el, provider) {
        const k = commsPreview.kind;
        const payload = { provider, kind: k };
        payload.subject = (el.querySelector('#cp-subject') || {}).value || '';
        payload.body = (el.querySelector('#cp-body') || {}).value || '';
        if (k === 'mail') {
            payload.to = (el.querySelector('#cp-to') || {}).value || '';
        } else {
            payload.start = (el.querySelector('#cp-start') || {}).value || '';
            payload.end = (el.querySelector('#cp-end') || {}).value || '';
            payload.location = (el.querySelector('#cp-location') || {}).value || '';
        }
        try {
            const res = await fetch('/api/comms/draft', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.status !== 'success') throw new Error(data.message || 'draft failed');
            if (data.mode === 'browser' && data.url) {
                window.open(data.url, '_blank');
            }
            toast(data.note || 'Draft opened — review and send manually.', 'success');
        } catch (e) { toast('Open draft failed: ' + e.message, 'error'); }
    }
    // ======================================================================
    // Model Cookbook (hardware-aware serving) — opens as a sidebar modal
    // ======================================================================
    let cookbookPulling = null;   // active EventSource

    window.openModelCookbook = function () {
        openToolModal('cookbook-modal');
        renderCookbook();
    };

    async function renderCookbook() {
        const el = document.getElementById('cookbook-modal-body');
        if (!el) return;
        el.innerHTML = `
          <div class="cook-note" id="cook-note" style="display:none;"></div>
          <div class="cook-hw" id="cook-hw">Scanning hardware…</div>
          <div class="cook-toolbar">
            <button id="cook-delete-toggle" class="cook-update-btn">🗑 Delete Models</button>
          </div>
          <div class="cook-delete-panel hidden" id="cook-delete-panel"></div>
          <div class="cook-grid" id="cook-grid"></div>`;
        const delToggle = el.querySelector('#cook-delete-toggle');
        if (delToggle) delToggle.addEventListener('click', () => toggleDeletePanel());
        try {
            const [scanRes, recRes] = await Promise.all([
                fetch('/api/cookbook/scan').then(r => r.json()),
                fetch('/api/cookbook/recommend').then(r => r.json())
            ]);
            // When the installed Ollama is older than the latest release, the
            // newest models (e.g. gemma4) can 412 on pull — show a prominent
            // warning ABOVE the specs with an in-app "Update Ollama" button.
            const note = el.querySelector('#cook-note');
            if (note) {
                const ver = recRes.ollama_version, latest = recRes.ollama_latest;
                if (recRes.ollama_installed === false) {
                    // Ollama not installed → offer a one-click in-app install (no terminal).
                    note.style.display = 'block';
                    note.classList.add('cook-note-warn');
                    note.innerHTML = `⚠️ Ollama isn't installed — it's required to run local models.
                        <button id="cook-install-ollama" class="cook-update-btn">⬇ Install Ollama</button>
                        <span id="cook-install-log" class="cook-update-log"></span>`;
                    const ib = note.querySelector('#cook-install-ollama');
                    if (ib) ib.addEventListener('click', () => installOllama(ib, note.querySelector('#cook-install-log')));
                } else if (recRes.ollama_outdated) {
                    note.style.display = 'block';
                    note.classList.add('cook-note-warn');
                    note.innerHTML = `⚠️ Your Ollama (<b>${esc(ver || '?')}</b>) is older than the latest (<b>${esc(latest || '?')}</b>). The newest models may fail to download until you update.
                        <button id="cook-update-ollama" class="cook-update-btn">⬇ Update Ollama</button>
                        <span id="cook-update-log" class="cook-update-log"></span>`;
                    const ub = note.querySelector('#cook-update-ollama');
                    if (ub) ub.addEventListener('click', () => updateOllama(ub, note.querySelector('#cook-update-log')));
                } else if (ver) {
                    note.style.display = 'block';
                    note.innerHTML = `ℹ️ Ollama <b>${esc(ver)}</b>. If a download ever fails with a version error, update at <a href="https://ollama.com/download" target="_blank" style="color:var(--accent);">ollama.com/download</a>.`;
                }
            }
            renderHw(el, scanRes.hardware || {}, recRes.available_gb);
            renderRecommendations(el, recRes.models || []);
        } catch (e) {
            el.querySelector('#cook-hw').textContent = 'Hardware scan failed: ' + e.message;
        }
    }

    function renderHw(el, hw, availGb) {
        el.querySelector('#cook-hw').innerHTML = `
          <span>🧠 RAM <b>${hw.ram_gb || '?'} GB</b></span>
          <span>⚙️ CPU <b>${hw.cpu_cores || '?'} cores</b></span>
          <span>🎮 GPU <b>${esc(hw.gpu || 'CPU')}</b></span>
          ${hw.vram_gb ? `<span>📦 VRAM <b>${hw.vram_gb} GB</b></span>` : ''}
          <span>📐 Budget <b>${availGb != null ? availGb + ' GB' : '?'}</b></span>`;
    }

    function renderRecommendations(el, models) {
        const grid = el.querySelector('#cook-grid');
        const bandLabel = { green: 'Great fit', yellow: 'Tight fit', red: 'May not fit' };
        grid.innerHTML = models.map(m => {
            // Models too big to serve directly are Deep-Think-only (AirLLM);
            // MLX models (Apple Silicon) serve via the local-mlx: provider.
            let action;
            if (m.serving === 'deepthink') {
                action = `<div class="cook-deepthink">
                     <span class="cook-dt-badge">🧠 Deep Think only</span>
                     <p class="cook-dt-note">Too large to serve directly. Runs layer-by-layer from RAM/disk
                       via the AirLLM Deep Think engine — accurate but slow.</p>
                     ${m.hf_repo
                        ? `<button class="cook-dt-btn" data-dt="${esc(m.hf_repo)}">Use in Deep Think →</button>`
                        : `<span class="cook-dt-na">No AirLLM repo mapped — informational only.</span>`}
                   </div>`;
            } else if (m.serving === 'mlx') {
                action = `<div class="cook-deepthink">
                     <span class="cook-dt-badge">🍎 Apple MLX</span>
                     <p class="cook-dt-note">Runs in unified memory via MLX (downloaded from HuggingFace on first use). Needs <code>mlx-lm</code> installed.</p>
                     <button class="cook-dt-btn" data-mlx="${esc(m.mlx_repo || m.model)}">Serve with MLX →</button>
                   </div>`;
            } else {
                const label = m.installed ? '⟳ Re-pull / Update' : '⬇ Download &amp; Serve';
                action = `<div class="cook-progress hidden">
                     <div class="cook-bar"><div class="cook-bar-fill"></div></div>
                     <span class="cook-prog-text"></span>
                   </div>
                   <button class="cook-pull" data-pull="${esc(m.model)}">${label}</button>`;
            }
            const installedBadge = m.installed ? `<span class="cook-installed" title="Already installed">✓ Installed</span>` : '';
            return `
          <div class="cook-card band-${m.band}${m.installed ? ' is-installed' : ''}">
            <div class="cook-card-top">
              <span class="cook-model">${esc(m.model)} ${installedBadge}</span>
              <span class="cook-fit cook-${m.band}" title="${bandLabel[m.band]}">${m.fit_score}</span>
            </div>
            <div class="cook-meta">${esc(m.params)} · ~${m.gb} GB · ${bandLabel[m.band]}</div>
            <div class="cook-note">${esc(m.note || '')}</div>
            ${action}
          </div>`;
        }).join('');
        grid.querySelectorAll('[data-pull]').forEach(b =>
            b.addEventListener('click', () => pullModel(b.getAttribute('data-pull'), b)));
        grid.querySelectorAll('[data-dt]').forEach(b =>
            b.addEventListener('click', () => {
                window.armDeepThink && window.armDeepThink(b.getAttribute('data-dt'));
                closeToolModal('cookbook-modal');
            }));
        grid.querySelectorAll('[data-mlx]').forEach(b =>
            b.addEventListener('click', () => {
                window.armMlxModel && window.armMlxModel(b.getAttribute('data-mlx'));
                closeToolModal('cookbook-modal');
            }));
    }

    function pullModel(model, btn) {
        // While a pull is running on THIS button, it acts as a Stop button.
        if (btn._pulling) {
            try { btn._es && btn._es.close(); } catch (_) {}
            btn._pulling = false; btn._es = null; cookbookPulling = null;
            btn.textContent = '⬇ Download & Serve';
            const t = btn.closest('.cook-card').querySelector('.cook-prog-text');
            if (t) t.textContent = 'Stopped.';
            toast('Download stopped.', 'info');
            return;
        }
        if (cookbookPulling) { toast('A download is already running.', 'info'); return; }
        const card = btn.closest('.cook-card');
        const prog = card.querySelector('.cook-progress');
        const fill = card.querySelector('.cook-bar-fill');
        const text = card.querySelector('.cook-prog-text');
        prog.classList.remove('hidden');
        btn.textContent = '■ Stop download';
        const es = new EventSource('/api/cookbook/pull?model=' + encodeURIComponent(model));
        cookbookPulling = es; btn._es = es; btn._pulling = true;
        const finish = (msg, ok) => {
            try { es.close(); } catch (_) {}
            cookbookPulling = null; btn._es = null; btn._pulling = false;
            btn.textContent = ok ? '✓ Installed' : '⬇ Download & Serve';
            text.textContent = msg || '';
            if (ok) {
                window.discoverLocalModels && window.discoverLocalModels();
                toast(model + ' is ready to serve.', 'success');
            }
        };
        es.onmessage = (ev) => {
            let p; try { p = JSON.parse(ev.data); } catch (_) { return; }
            if (p.error) { finish('Error: ' + p.error, false); toast('Pull failed: ' + p.error, 'error'); return; }
            if (p.done) { fill.style.width = '100%'; finish('Done', true); return; }
            if (p.pct != null) { fill.style.width = p.pct + '%'; text.textContent = p.status + ' ' + p.pct + '%'; }
            else if (p.status) { text.textContent = p.status; }
        };
        es.onerror = () => finish('Connection lost', false);
    }

    // ---- Delete installed models (in-app, no `ollama rm`) ----
    function toggleDeletePanel() {
        const panel = document.getElementById('cook-delete-panel');
        if (!panel) return;
        if (panel.classList.contains('hidden')) {
            panel.classList.remove('hidden');
            renderDeleteList(panel);
        } else {
            panel.classList.add('hidden');
        }
    }

    async function renderDeleteList(panel) {
        panel.innerHTML = '<div class="cook-del-loading">Loading installed models…</div>';
        try {
            const res = await fetch('/api/cookbook/installed').then(r => r.json());
            if (res.error) { panel.innerHTML = `<div class="cook-del-empty">${esc(res.error)}</div>`; return; }
            const models = res.models || [];
            if (!models.length) { panel.innerHTML = '<div class="cook-del-empty">No models installed.</div>'; return; }
            panel.innerHTML = models.map(m => `
              <div class="cook-del-row">
                <span class="cook-del-name">${esc(m.name)} <span class="cook-del-size">· ${m.size_gb} GB</span></span>
                <button class="cook-del-btn" data-del="${esc(m.name)}">Delete</button>
              </div>`).join('');
            panel.querySelectorAll('[data-del]').forEach(b =>
                b.addEventListener('click', () => deleteModel(b.getAttribute('data-del'), b, b.closest('.cook-del-row'))));
        } catch (e) {
            panel.innerHTML = `<div class="cook-del-empty">Failed to load: ${esc(e.message)}</div>`;
        }
    }

    function deleteModel(name, btn, row) {
        // Two-click confirm so nothing is removed by accident.
        if (!btn._armed) {
            btn._armed = true;
            btn.classList.add('confirm');
            btn.textContent = 'Confirm?';
            btn._disarm = setTimeout(() => {
                btn._armed = false; btn.classList.remove('confirm'); btn.textContent = 'Delete';
            }, 4000);
            return;
        }
        clearTimeout(btn._disarm);
        btn._armed = false; btn.disabled = true; btn.textContent = 'Deleting…';
        fetch('/api/cookbook/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: name })
        }).then(r => r.json()).then(res => {
            if (res.error) {
                toast('Delete failed: ' + res.error, 'error');
                btn.disabled = false; btn.classList.remove('confirm'); btn.textContent = 'Delete';
                return;
            }
            if (row) row.remove();
            toast(name + ' deleted.', 'success');
            window.discoverLocalModels && window.discoverLocalModels();
            // Refresh the recommendation cards so the "✓ Installed" badge updates.
            setTimeout(() => renderCookbook(), 600);
        }).catch(e => {
            toast('Delete failed: ' + e.message, 'error');
            btn.disabled = false; btn.classList.remove('confirm'); btn.textContent = 'Delete';
        });
    }

    // Update Ollama in-app (streamed). `btn` = the Update button, `log` = a span.
    function updateOllama(btn, log) {
        if (btn._running) return;
        btn._running = true; btn.disabled = true; btn.textContent = 'Updating…';
        const es = new EventSource('/api/cookbook/update-ollama');
        const done = (ok) => {
            try { es.close(); } catch (_) {}
            btn._running = false; btn.disabled = false;
            btn.textContent = ok ? '✓ Updated — reopen Cookbook' : '⬇ Update Ollama';
            if (ok) setTimeout(() => renderCookbook(), 1200);
        };
        es.onmessage = (ev) => {
            let p; try { p = JSON.parse(ev.data); } catch (_) { return; }
            if (p.error) { if (log) log.textContent = ' ' + p.error; toast(p.error, 'error'); done(false); return; }
            if (log) log.textContent = ' ' + (p.status || '');
            if (p.done) { toast('Ollama updated.', 'success'); done(true); }
        };
        es.onerror = () => { if (log) log.textContent = ' Update connection lost.'; done(false); };
    }

    // Install Ollama in-app (streamed) when it isn't present. Same pattern as update.
    function installOllama(btn, log) {
        if (btn._running) return;
        btn._running = true; btn.disabled = true; btn.textContent = 'Installing…';
        const es = new EventSource('/api/cookbook/install-ollama');
        const done = (ok) => {
            try { es.close(); } catch (_) {}
            btn._running = false; btn.disabled = false;
            btn.textContent = ok ? '✓ Installed — reopen Cookbook' : '⬇ Install Ollama';
            if (ok) setTimeout(() => renderCookbook(), 1500);
        };
        es.onmessage = (ev) => {
            let p; try { p = JSON.parse(ev.data); } catch (_) { return; }
            if (p.error) { if (log) log.textContent = ' ' + p.error; toast(p.error, 'error'); done(false); return; }
            if (log) log.textContent = ' ' + (p.status || '');
            if (p.done) { toast('Ollama installed.', 'success'); done(true); }
        };
        es.onerror = () => { if (log) log.textContent = ' Install connection lost.'; done(false); };
    }
    // ======================================================================
    // Part D — Model Compare (blind testing)
    // ======================================================================
    let compareES = null;
    let compareMap = null;   // { A: realModel, B: realModel } — kept secret until reveal
    let compareVoted = false;

    window.openModelCompare = function () {
        openToolModal('compare-modal');
        renderCompare();
    };

    async function renderCompare() {
        const el = document.getElementById('compare-modal-body');
        if (!el) return;
        el.innerHTML = `
          <div class="cmp-setup">
            <div class="cmp-pickers">
              <select id="cmp-m1"></select>
              <span class="cmp-vs">vs</span>
              <select id="cmp-m2"></select>
            </div>
            <textarea id="cmp-prompt" rows="2" placeholder="Enter a prompt to send to both models…"></textarea>
            <button id="cmp-run" class="comms-go">Run blind test →</button>
          </div>
          <div class="cmp-arena hidden" id="cmp-arena">
            <div class="cmp-col" data-col="A">
              <div class="cmp-col-head">Model A</div>
              <div class="cmp-out" id="cmp-out-A"></div>
              <button class="cmp-vote" data-vote="A">👍 A is better</button>
            </div>
            <div class="cmp-col" data-col="B">
              <div class="cmp-col-head">Model B</div>
              <div class="cmp-out" id="cmp-out-B"></div>
              <button class="cmp-vote" data-vote="B">👍 B is better</button>
            </div>
          </div>
          <div class="cmp-tie-row hidden" id="cmp-tie-row">
            <button class="cmp-vote cmp-tie" data-vote="tie">🤝 It's a tie</button>
          </div>
          <div class="cmp-reveal hidden" id="cmp-reveal"></div>`;
        // Populate model pickers.
        let models = [];
        try {
            const data = await fetch('/api/local-models').then(r => r.json());
            models = (data && data.models) || [];
        } catch (_) {}
        const opts = models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
        const m1 = el.querySelector('#cmp-m1'), m2 = el.querySelector('#cmp-m2');
        m1.innerHTML = opts; m2.innerHTML = opts;
        if (models.length > 1) m2.selectedIndex = 1;
        if (!models.length) {
            el.querySelector('#cmp-run').disabled = true;
            el.querySelector('.cmp-pickers').insertAdjacentHTML('afterend',
                `<p class="util-empty">No local models found — install some in the Cookbook first.</p>`);
        }
        el.querySelector('#cmp-run').addEventListener('click', () => runCompare(el));
        el.querySelectorAll('.cmp-vote').forEach(b =>
            b.addEventListener('click', () => castVote(el, b.getAttribute('data-vote'))));
    }

    function runCompare(el) {
        if (compareES) { try { compareES.close(); } catch (_) {} compareES = null; }
        const m1 = el.querySelector('#cmp-m1').value;
        const m2 = el.querySelector('#cmp-m2').value;
        const prompt = el.querySelector('#cmp-prompt').value.trim();
        if (!prompt) { toast('Enter a prompt first.', 'info'); return; }
        if (m1 === m2) { toast('Pick two different models for a fair test.', 'info'); return; }
        // Anonymize + randomize: shuffle which real model is behind column A vs B.
        const flip = Math.random() < 0.5;
        compareMap = { A: flip ? m2 : m1, B: flip ? m1 : m2 };
        compareVoted = false;
        el.querySelector('#cmp-arena').classList.remove('hidden');
        el.querySelector('#cmp-tie-row').classList.remove('hidden');
        el.querySelector('#cmp-reveal').classList.add('hidden');
        const outA = el.querySelector('#cmp-out-A'), outB = el.querySelector('#cmp-out-B');
        outA.textContent = ''; outB.textContent = '';
        el.querySelectorAll('.cmp-vote').forEach(b => { b.disabled = false; });
        const url = '/api/compare?prompt=' + encodeURIComponent(prompt) +
            '&model_a=' + encodeURIComponent(compareMap.A) +
            '&model_b=' + encodeURIComponent(compareMap.B);
        const es = new EventSource(url);
        compareES = es;
        es.onmessage = (ev) => {
            let p; try { p = JSON.parse(ev.data); } catch (_) { return; }
            if (p.done) { try { es.close(); } catch (_) {} compareES = null; return; }
            if (p.text) {
                const out = p.col === 'A' ? outA : outB;
                out.textContent += p.text;
                out.scrollTop = out.scrollHeight;
            }
        };
        es.onerror = () => { try { es.close(); } catch (_) {} compareES = null; };
    }

    async function castVote(el, winner) {
        if (compareVoted || !compareMap) return;
        compareVoted = true;
        el.querySelectorAll('.cmp-vote').forEach(b => { b.disabled = true; });
        const prompt = el.querySelector('#cmp-prompt').value.trim();
        try {
            await fetch('/api/compare/vote', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, model_a: compareMap.A, model_b: compareMap.B, winner })
            });
        } catch (e) { toast('Vote save failed: ' + e.message, 'error'); }
        // Reveal the mapping.
        const pick = winner === 'tie' ? 'Tie' :
            (winner === 'A' ? compareMap.A : compareMap.B) + ' wins';
        el.querySelector('#cmp-reveal').innerHTML =
            `<b>Revealed:</b> Model A = <code>${esc(compareMap.A)}</code> · Model B = <code>${esc(compareMap.B)}</code> — <b>${esc(pick)}</b>`;
        el.querySelector('#cmp-reveal').classList.remove('hidden');
    }
})();

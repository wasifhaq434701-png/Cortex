/* ==========================================================================
 * Cortex IDE — OS Menu Bar
 * Data-driven menu system. Every item maps to a real action: Monaco's built-in
 * editor actions (the same ones VS Code's web build uses) or the global helper
 * functions defined in studio.js.
 * ========================================================================== */
(function () {
    'use strict';

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const MOD = isMac ? '⌘' : 'Ctrl';
    const ALT = isMac ? '⌥' : 'Alt';
    const SHIFT = isMac ? '⇧' : 'Shift';

    // ---- small helpers -----------------------------------------------------
    function ed() { return window.editor || null; }
    function toast(m, t) { (window.showToast || console.log)(m, t || 'info'); }

    function ensureStudio() {
        // The IDE menu actions need the Cortex IDE surface specifically.
        if (!document.body.classList.contains('surface-ide')) {
            if (window.switchSurface) window.switchSurface('ide');
        }
    }

    // Run a Monaco editor action by id, focusing the editor first.
    function mAction(id, opts) {
        const e = ed();
        if (!e) { ensureStudio(); toast('Open a file in the Studio first.', 'info'); return false; }
        e.focus();
        const a = e.getAction(id);
        if (a) { a.run(); return true; }
        if (opts && opts.trigger) { e.trigger('menubar', opts.trigger, null); return true; }
        toast('Action not available here.', 'info');
        return false;
    }
    function mTrigger(cmd) {
        const e = ed();
        if (!e) { ensureStudio(); toast('Open a file in the Studio first.', 'info'); return; }
        e.focus();
        e.trigger('menubar', cmd, null);
    }

    function showBottom(target) {
        ensureStudio();
        const panel = document.querySelector('.studio-bottom-panel');
        if (panel && panel.classList.contains('collapsed') && typeof toggleBottomPanel === 'function') toggleBottomPanel();
        const tab = document.querySelector(`.studio-bottom-tabs .studio-tab[data-target="${target}"]`);
        if (tab) tab.click();
    }
    function showActivity(target) {
        ensureStudio();
        const sb = document.getElementById('studio-sidebar');
        if (sb && sb.classList.contains('collapsed') && typeof toggleLeftSidebar === 'function') toggleLeftSidebar();
        const btn = document.querySelector(`.studio-activity-bar .activity-btn[data-target="${target}"]`);
        if (btn) btn.click();
    }

    // Flatten the workspace tree to relative paths for "Go to File".
    async function goToFile() {
        ensureStudio();
        const cwd = document.getElementById('dir-input')?.value || '';
        const url = cwd ? `/api/workspace/files?cwd=${encodeURIComponent(cwd)}` : '/api/workspace/files';
        try {
            const data = await (await fetch(url)).json();
            const out = [];
            (function walk(node, prefix) {
                if (!node) return;
                Object.keys(node).forEach(k => {
                    const p = prefix ? prefix + '/' + k : k;
                    if (node[k] === null) out.push(p); else walk(node[k], p);
                });
            })(data.tree, '');
            if (out.length === 0) { toast('No files found.', 'info'); return; }
            window.showQuickPick('Go to File', out.map(p => ({ label: p.split('/').pop(), sublabel: p, value: p })), (p) => openWorkspaceFile(p));
        } catch (e) { toast('Could not list files.', 'error'); }
    }

    function closeFolder() {
        const dirInput = document.getElementById('dir-input');
        if (dirInput) dirInput.value = '';
        localStorage.removeItem('last_workspace_dir');
        (window.openTabs || []).slice().forEach(t => closeTab(null, t.absolutePath));
        if (typeof loadWorkspaceFiles === 'function') loadWorkspaceFiles();
        toast('Workspace closed.', 'info');
    }

    function openRecent() {
        const last = localStorage.getItem('last_workspace_dir');
        if (!last) { toast('No recent folders.', 'info'); return; }
        window.showQuickPick('Open Recent', [{ label: last.split('/').pop() || last, sublabel: last, value: last }], (dir) => {
            const di = document.getElementById('dir-input');
            if (di) { di.value = dir; localStorage.setItem('last_workspace_dir', dir); }
            if (typeof loadWorkspaceFiles === 'function') loadWorkspaceFiles();
            if (typeof restartTerminal === 'function') restartTerminal();
        });
    }

    // Word wrap / minimap toggles with reliable checkmark state.
    window._wordWrapOn = false;
    window._minimapOn = true;
    function toggleWordWrap() {
        window._wordWrapOn = !window._wordWrapOn;
        window.ideEditors && window.ideEditors.forEach(e => e && e.updateOptions({ wordWrap: window._wordWrapOn ? 'on' : 'off' }));
        toast('Word Wrap ' + (window._wordWrapOn ? 'on' : 'off'), 'info');
    }
    function toggleMinimap() {
        window._minimapOn = !window._minimapOn;
        window.ideEditors && window.ideEditors.forEach(e => e && e.updateOptions({ minimap: { enabled: window._minimapOn } }));
        toast('Minimap ' + (window._minimapOn ? 'on' : 'off'), 'info');
    }
    function toggleTheme() {
        if (typeof window.toggleTheme === 'function' && window.toggleTheme !== toggleTheme) { /* app theme */ }
        const themeBtn = document.getElementById('theme-toggle-btn');
        if (themeBtn) themeBtn.click(); // reuse app-v12 theme switch if present
        if (window.monaco) {
            const cur = document.body.getAttribute('data-monaco-theme') === 'vs' ? 'vs-dark' : 'vs';
            monaco.editor.setTheme(cur);
            document.body.setAttribute('data-monaco-theme', cur);
        }
    }

    // Zoom (Window menu) via CSS zoom on the workspace.
    window._zoom = 1;
    function applyZoom() {
        document.querySelector('.workspace-container').style.zoom = window._zoom;
        window.ideEditors && window.ideEditors.forEach(e => e && e.layout());
    }
    function zoomIn() { window._zoom = Math.min(window._zoom + 0.1, 2); applyZoom(); }
    function zoomOut() { window._zoom = Math.max(window._zoom - 0.1, 0.5); applyZoom(); }
    function zoomReset() { window._zoom = 1; applyZoom(); }
    function toggleFullScreen() {
        if (!document.fullscreenElement) { document.documentElement.requestFullscreen?.(); }
        else { document.exitFullscreen?.(); }
    }

    function showShortcuts() {
        const list = [
            ['Save', `${MOD} S`], ['Save All', `${MOD} ${SHIFT} S`], ['Run File', 'F5'],
            ['Toggle Breakpoint', 'F9'], ['Toggle Sidebar', `${MOD} B`], ['Toggle Panel', `${MOD} J`],
            ['Toggle Copilot', `${MOD} I`], ['Close Editor', `${MOD} W`], ['Command Palette', `${MOD} ${SHIFT} P`],
            ['Find', `${MOD} F`], ['Replace', `${MOD} ${ALT} F`], ['Comment Line', `${MOD} /`]
        ];
        window.showQuickPick('Keyboard Shortcuts', list.map(([l, k]) => ({ label: l, sublabel: k, value: l })), () => {});
    }

    function debugStep(cmd) { // pdb-style stepping into the active terminal
        if (typeof window.sendToTerminal === 'function') window.sendToTerminal(cmd + '\n');
        else toast('No active terminal.', 'info');
    }

    // ---- menu definitions --------------------------------------------------
    const sep = { sep: true };
    const MENUS = [
        {
            name: 'File', items: [
                { label: 'New Text File', key: `${MOD} N`, run: () => { ensureStudio(); window.newUntitledFile && window.newUntitledFile(); } },
                { label: 'New File...', run: () => window.createFile && window.createFile() },
                { label: 'New Window', key: `${MOD} ${SHIFT} N`, run: () => window.open(location.href, '_blank') },
                sep,
                { label: 'Open File...', key: `${MOD} O`, run: () => window.promptWorkspaceFile && window.promptWorkspaceFile() },
                { label: 'Open Folder...', run: () => window.promptWorkspace && window.promptWorkspace() },
                { label: 'Open Recent', run: openRecent },
                sep,
                { label: 'Save', key: `${MOD} S`, run: () => window.saveActiveFile && window.saveActiveFile() },
                { label: 'Save As...', key: `${MOD} ${SHIFT} S`, run: () => window.saveActiveFileAs && window.saveActiveFileAs() },
                { label: 'Save All', run: () => window.saveAllFiles && window.saveAllFiles() },
                sep,
                { label: 'Auto Save', check: () => window.autoSaveEnabled, run: () => window.toggleAutoSave && window.toggleAutoSave() },
                { label: 'Revert File', run: () => window.revertActiveFile && window.revertActiveFile() },
                sep,
                { label: 'Close Editor', key: `${MOD} W`, run: () => { if (window.activeTabPath) closeTab(null, window.activeTabPath); } },
                { label: 'Close Folder', run: closeFolder },
                { label: 'Close Window', run: () => window.close() }
            ]
        },
        {
            name: 'Edit', items: [
                { label: 'Undo', key: `${MOD} Z`, run: () => mTrigger('undo') },
                { label: 'Redo', key: `${MOD} ${SHIFT} Z`, run: () => mTrigger('redo') },
                sep,
                { label: 'Cut', key: `${MOD} X`, run: () => mAction('editor.action.clipboardCutAction') },
                { label: 'Copy', key: `${MOD} C`, run: () => mAction('editor.action.clipboardCopyAction') },
                { label: 'Paste', key: `${MOD} V`, run: () => mAction('editor.action.clipboardPasteAction') },
                sep,
                { label: 'Find', key: `${MOD} F`, run: () => mAction('actions.find') },
                { label: 'Replace', key: `${MOD} ${ALT} F`, run: () => mAction('editor.action.startFindReplaceAction') },
                { label: 'Find in Files', key: `${MOD} ${SHIFT} F`, run: () => showActivity('search') },
                { label: 'Replace in Files', key: `${MOD} ${SHIFT} H`, run: () => showActivity('search') },
                sep,
                { label: 'Toggle Line Comment', key: `${MOD} /`, run: () => mAction('editor.action.commentLine') },
                { label: 'Toggle Block Comment', key: `${MOD} ${SHIFT} A`, run: () => mAction('editor.action.blockComment') },
                { label: 'Emmet: Expand Abbreviation', run: () => mAction('editor.emmet.action.expandAbbreviation') }
            ]
        },
        {
            name: 'Selection', items: [
                { label: 'Select All', key: `${MOD} A`, run: () => mAction('editor.action.selectAll') },
                { label: 'Expand Selection', run: () => mAction('editor.action.smartSelect.expand') },
                { label: 'Shrink Selection', run: () => mAction('editor.action.smartSelect.shrink') },
                sep,
                { label: 'Copy Line Up', run: () => mAction('editor.action.copyLinesUpAction') },
                { label: 'Copy Line Down', run: () => mAction('editor.action.copyLinesDownAction') },
                { label: 'Move Line Up', key: `${ALT} ↑`, run: () => mAction('editor.action.moveLinesUpAction') },
                { label: 'Move Line Down', key: `${ALT} ↓`, run: () => mAction('editor.action.moveLinesDownAction') },
                { label: 'Duplicate Selection', run: () => mAction('editor.action.duplicateSelection') },
                sep,
                { label: 'Add Cursor Above', run: () => mAction('editor.action.insertCursorAbove') },
                { label: 'Add Cursor Below', run: () => mAction('editor.action.insertCursorBelow') },
                { label: 'Add Cursors to Line Ends', run: () => mAction('editor.action.insertCursorAtEndOfEachLineSelected') },
                { label: 'Add Next Occurrence', key: `${MOD} D`, run: () => mAction('editor.action.addSelectionToNextFindMatch') },
                { label: 'Select All Occurrences', run: () => mAction('editor.action.selectHighlights') }
            ]
        },
        {
            name: 'View', items: [
                { label: 'Command Palette...', key: `${MOD} ${SHIFT} P`, run: () => mAction('editor.action.quickCommand') },
                { label: 'Open View...', run: () => window.showQuickPick('Open View', [
                    { label: 'Explorer', value: 'explorer' }, { label: 'Search', value: 'search' },
                    { label: 'Source Control', value: 'git' }, { label: 'Terminal', value: 'terminal' },
                    { label: 'Problems', value: 'problems' }, { label: 'Output', value: 'output' }
                ], (v) => { ['terminal', 'problems', 'output'].includes(v) ? showBottom(v) : showActivity(v); }) },
                sep,
                { label: 'Explorer', key: `${MOD} ${SHIFT} E`, run: () => showActivity('explorer') },
                { label: 'Search', run: () => showActivity('search') },
                { label: 'Source Control', key: `${MOD} ${SHIFT} G`, run: () => showActivity('git') },
                { label: 'Copilot Chat', key: `${MOD} I`, run: () => typeof toggleCopilotSidebar === 'function' && toggleCopilotSidebar() },
                sep,
                { label: 'Problems', key: `${MOD} ${SHIFT} M`, run: () => showBottom('problems') },
                { label: 'Output', key: `${MOD} ${SHIFT} U`, run: () => showBottom('output') },
                { label: 'Debug Console', key: `${MOD} ${SHIFT} Y`, run: () => showBottom('debug-console') },
                { label: 'Terminal', key: `${MOD} \``.trim(), run: () => window.openTerminalPanel && window.openTerminalPanel() },
                sep,
                { label: 'Split Editor', run: () => window.toggleSplitScreen && window.toggleSplitScreen() },
                { label: 'Word Wrap', key: `${ALT} Z`, check: () => window._wordWrapOn, run: toggleWordWrap },
                { label: 'Show Minimap', check: () => window._minimapOn, run: toggleMinimap },
                { label: 'Toggle Light/Dark Theme', run: toggleTheme }
            ]
        },
        {
            name: 'Go', items: [
                { label: 'Back', run: () => mAction('editor.action.navigateBack', { trigger: 'editor.action.navigateBackInNavigationLocations' }) },
                { label: 'Forward', run: () => mAction('editor.action.navigateForward', { trigger: 'editor.action.navigateForwardInNavigationLocations' }) },
                sep,
                { label: 'Go to File...', key: `${MOD} P`, run: goToFile },
                { label: 'Go to Symbol in Editor...', key: `${MOD} ${SHIFT} O`, run: () => mAction('editor.action.quickOutline') },
                { label: 'Go to Line/Column...', key: `${MOD} G`, run: () => mAction('editor.action.gotoLine') },
                sep,
                { label: 'Go to Definition', key: 'F12', run: () => mAction('editor.action.revealDefinition') },
                { label: 'Go to References', key: `${SHIFT} F12`, run: () => mAction('editor.action.goToReferences') },
                sep,
                { label: 'Next Problem', key: 'F8', run: () => mAction('editor.action.marker.next') },
                { label: 'Previous Problem', key: `${SHIFT} F8`, run: () => mAction('editor.action.marker.prev') }
            ]
        },
        {
            name: 'Run', items: [
                { label: 'Start Debugging', key: 'F5', run: () => window.debugCommandF5 ? window.debugCommandF5() : (window.debugActiveFile && window.debugActiveFile()) },
                { label: 'Run Without Debugging', key: `${MOD} F5`, run: () => window.runActiveFile && window.runActiveFile() },
                { label: 'Stop Debugging', key: `${SHIFT} F5`, run: () => (window.dapIsActive && window.dapIsActive()) ? window.dapStop() : debugStep('\x03') },
                { label: 'Restart Debugging', key: `${MOD} ${SHIFT} F5`, run: () => (window.dapIsActive && window.dapIsActive()) ? window.dapRestart() : (debugStep('\x03'), setTimeout(() => window.debugActiveFile && window.debugActiveFile(), 250)) },
                sep,
                { label: 'Step Over', key: 'F10', run: () => (window.dapIsActive && window.dapIsActive()) ? window.dapStepOver() : debugStep('n') },
                { label: 'Step Into', key: 'F11', run: () => (window.dapIsActive && window.dapIsActive()) ? window.dapStepIn() : debugStep('s') },
                { label: 'Step Out', key: `${SHIFT} F11`, run: () => (window.dapIsActive && window.dapIsActive()) ? window.dapStepOut() : debugStep('r') },
                { label: 'Continue', run: () => (window.dapIsActive && window.dapIsActive()) ? window.dapContinue() : debugStep('c') },
                sep,
                { label: 'Toggle Breakpoint', key: 'F9', run: () => window.toggleBreakpointAtCursor && window.toggleBreakpointAtCursor() },
                { label: 'Enable All Breakpoints', run: () => window.setAllBreakpointsEnabled && window.setAllBreakpointsEnabled(true) },
                { label: 'Disable All Breakpoints', run: () => window.setAllBreakpointsEnabled && window.setAllBreakpointsEnabled(false) },
                { label: 'Remove All Breakpoints', run: () => window.removeAllBreakpoints && window.removeAllBreakpoints() },
                sep,
                { label: 'Install Additional Debuggers...', run: () => toast('Visual debugging: Python (built-in), C/C++/Rust via lldb-dap, Go via delve — installed adapters are detected automatically.', 'info') }
            ]
        },
        {
            name: 'Terminal', items: [
                { label: 'New Terminal', key: `${MOD} ${SHIFT} \``.trim(), run: () => window.newTerminalSession && window.newTerminalSession() },
                { label: 'Split Terminal', run: () => window.splitTerminalSession && window.splitTerminalSession() },
                { label: 'New Terminal Window', run: () => window.newTerminalWindow && window.newTerminalWindow() },
                sep,
                { label: 'Run Task...', run: () => window.runTask && window.runTask() },
                { label: 'Run Build Task...', key: `${MOD} ${SHIFT} B`, run: () => window.runBuildTask && window.runBuildTask() },
                { label: 'Run Active File', run: () => window.runActiveFile && window.runActiveFile() },
                { label: 'Run Selected Text', run: () => window.runSelectedText && window.runSelectedText() },
                sep,
                { label: 'Show Running Tasks...', run: () => window.showRunningTasks && window.showRunningTasks() },
                { label: 'Restart Running Task...', run: () => window.restartRunningTask && window.restartRunningTask() },
                { label: 'Terminate Task...', run: () => window.terminateTask && window.terminateTask() },
                sep,
                { label: 'Configure Tasks...', run: () => window.configureTasks && window.configureTasks() },
                { label: 'Configure Default Build Task...', run: () => window.configureDefaultBuildTask && window.configureDefaultBuildTask() }
            ]
        },
        {
            name: 'Window', items: [
                { label: 'New Window', run: () => window.open(location.href, '_blank') },
                sep,
                { label: 'Switch Studio / Chat', run: () => { if (window.switchSurface) window.switchSurface(document.body.classList.contains('studio-active') ? 'chat' : 'ide'); } },
                sep,
                { label: 'Zoom In', key: `${MOD} +`, run: zoomIn },
                { label: 'Zoom Out', key: `${MOD} -`, run: zoomOut },
                { label: 'Reset Zoom', run: zoomReset },
                sep,
                { label: 'Toggle Full Screen', key: isMac ? `${MOD} ${MOD} F` : 'F11', run: toggleFullScreen }
            ]
        },
        {
            name: 'Help', items: [
                { label: 'Welcome', run: () => { const b = document.getElementById('studio-exit-btn'); if (b && document.body.classList.contains('studio-active')) b.click(); } },
                { label: 'Keyboard Shortcuts', run: showShortcuts },
                sep,
                { label: 'About Cortex IDE', run: () => toast('Cortex IDE — Local-first AI Data Intelligence OS.', 'info') }
            ]
        }
    ];

    // ---- visibility (forgiving auto-hide) ----------------------------------
    // The bar is a hover-revealed overlay. Pure CSS :hover snapped it away the
    // instant the pointer left; here we hold it open with an `is-open` class +
    // a grace delay, keep it open while any menu is hovered, and pin on click.
    let menuHideTimer = null;
    let menuPinned = false;

    function showMenuBar() {
        const bar = document.getElementById('os-menu-bar');
        if (!bar) return;
        clearTimeout(menuHideTimer);
        bar.classList.add('is-open');
    }
    function scheduleHideMenuBar() {
        if (menuPinned) return;
        const bar = document.getElementById('os-menu-bar');
        if (!bar) return;
        clearTimeout(menuHideTimer);
        menuHideTimer = setTimeout(() => bar.classList.remove('is-open'), 600);
    }
    function wireMenuVisibility() {
        const bar = document.getElementById('os-menu-bar');
        const trigger = document.querySelector('.os-menu-trigger');
        if (!bar || bar.dataset.visWired) return;
        bar.dataset.visWired = '1';
        [trigger, bar].forEach(el => {
            if (!el) return;
            el.addEventListener('mouseenter', showMenuBar);
            el.addEventListener('mouseleave', scheduleHideMenuBar);
        });
        // Click anywhere outside the bar/trigger unpins and hides it.
        document.addEventListener('click', (ev) => {
            if (bar.contains(ev.target) || (trigger && trigger.contains(ev.target))) return;
            menuPinned = false;
            scheduleHideMenuBar();
        });
    }

    // ---- rendering ---------------------------------------------------------
    function renderMenus() {
        const nav = document.getElementById('os-menu-bar');
        if (!nav) return;
        nav.innerHTML = '';

        const title = document.createElement('div');
        title.className = 'os-menu-item title';
        title.textContent = 'Cortex IDE';
        nav.appendChild(title);

        MENUS.forEach(menu => {
            const item = document.createElement('div');
            item.className = 'os-menu-item has-dropdown';
            item.appendChild(document.createTextNode(menu.name));

            const dd = document.createElement('div');
            dd.className = 'os-menu-dropdown';

            menu.items.forEach(entry => {
                if (entry.sep) {
                    const s = document.createElement('div');
                    s.className = 'dropdown-sep';
                    dd.appendChild(s);
                    return;
                }
                const di = document.createElement('div');
                di.className = 'dropdown-item';
                di.dataset.hasCheck = entry.check ? '1' : '';

                const check = document.createElement('span');
                check.className = 'dropdown-check';
                const label = document.createElement('span');
                label.className = 'dropdown-label';
                label.textContent = entry.label;
                const key = document.createElement('span');
                key.className = 'dropdown-key';
                key.textContent = entry.key || '';

                di.appendChild(check);
                di.appendChild(label);
                di.appendChild(key);

                di._check = entry.check || null;
                di.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    try { entry.run(); } catch (e) { console.error(e); toast('Action failed: ' + e.message, 'error'); }
                    // collapse the dropdown by briefly removing hover affordance
                    item.classList.add('force-closed');
                    setTimeout(() => item.classList.remove('force-closed'), 250);
                    // picking an action unpins and closes the bar shortly after
                    menuPinned = false;
                    scheduleHideMenuBar();
                });
                dd.appendChild(di);
            });

            // refresh checkmarks each time the menu opens, and keep the bar
            // visible the whole time any menu/dropdown is hovered.
            item.addEventListener('mouseenter', () => {
                showMenuBar();
                dd.querySelectorAll('.dropdown-item').forEach(di => {
                    if (di._check) di.classList.toggle('checked', !!di._check());
                });
            });

            // Click a top-level title to PIN the bar open (OS-style) until
            // an action is picked or the user clicks away.
            item.addEventListener('click', (ev) => {
                if (ev.target.closest('.dropdown-item')) return; // leaf clicks handled below
                ev.stopPropagation();
                menuPinned = !menuPinned;
                showMenuBar();
            });

            item.appendChild(dd);
            nav.appendChild(item);
        });
    }

    function initMenuBar() {
        renderMenus();
        wireMenuVisibility();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMenuBar);
    } else {
        initMenuBar();
    }
})();

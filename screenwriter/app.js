/* ==========================================================================
   Screenwriter v2 - ScreenFlow Editor Logic & State Management
   --------------------------------------------------------------------------
   Rewrite notes (what changed vs v1, and why):
   - All localStorage keys are unchanged, so existing scripts load as-is.
   - Fountain import / paste / registries no longer build HTML strings from
     unescaped text (a "<" in a script used to corrupt the document). Blocks
     are now built as DOM nodes.
   - Typing no longer rebuilds the whole outline/registries on every
     keystroke; analysis is debounced and lists only re-render when their
     contents actually change.
   - Backspace/Delete merge blocks properly; Enter on an empty
     Character/Dialogue/Parenthetical drops back to Action.
   - The custom format undo no longer fights the browser's text undo, and
     auto-detected scene headings no longer pollute the redo stack.
   - Switching scripts clears the on-disk file handle (v1 could autosave
     the new script over the previous script's .fountain file).
   - Autosave failures (storage quota) are caught and surfaced instead of
     silently killing saving; pending saves flush when the tab hides/closes.
   - Autocomplete is positioned with position:fixed from the caret rect
     (v1 added window scroll offsets to a box inside a scrolling viewport,
     so it drifted), and accepting a suggestion can't crash on empty blocks.
   - The PDF title page is only generated when Author/Contact metadata
     exists, and page numbers are computed from the real first script page.
   - Dead v1 code removed (page-break enforcer / page-number painter were
     defined but never called; pages are now shown as visual page guides
     in CSS and counted from the real page height).
   - Cmd (Mac) shortcuts work alongside Ctrl; Ctrl+S saves; find & replace
     added; Esc closes menus/modals; icons are refreshed safely.
   ========================================================================== */

// --- IndexedDB helpers (FileSystemHandles can't go in localStorage) ---
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('screenflow_db', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    const req = tx.objectStore('kv').put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// --- Safe storage wrappers: private mode / quota must never throw ---
const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch (e) {} },
  getJSON(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch (e) { return fallback; }
  }
};

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

document.addEventListener('DOMContentLoaded', () => {
  if (window.__screenwriterBooted) return; // never wire the editor twice
  window.__screenwriterBooted = true;
  const $ = (id) => document.getElementById(id);
  const editor = $('screenplay-editor');
  const sidebar = $('sidebar');
  const toggleSidebarBtn = $('toggle-sidebar-btn');
  const expandSidebarBtn = $('expand-sidebar-btn');
  const sidebarScrim = $('sidebar-scrim');
  const themeToggleBtn = $('theme-toggle-btn');
  const helpToggleBtn = $('help-toggle-btn');
  const helpModal = $('help-modal');
  const scriptTitleInput = $('script-title-input');
  const zoomSlider = $('zoom-slider');
  const zoomSliderLabel = $('zoom-slider-label');
  const paperContainer = $('paper-container');
  const formatPickerBtn = $('format-picker-btn');
  const formatPickerDropdown = $('format-picker-dropdown');
  const formatPickerLabel = $('format-picker-label');
  const formatOptions = document.querySelectorAll('.format-option');
  const btnExportPdf = $('btn-export-pdf');
  const btnExportFountain = $('btn-export-fountain');
  const btnOpenScript = $('btn-open-script');
  const importFountainFile = $('import-fountain-file');
  const btnNewScript = $('btn-new-script');
  const btnFindOpen = $('btn-find-open');
  const btnPrint = $('btn-print');
  const menuBtn = $('menu-btn');
  const menuDropdown = $('menu-dropdown');
  const toggleHighlights = $('toggle-highlights');
  const toggleSpellcheck = $('toggle-spellcheck');
  const toggleRegistry = $('toggle-registry');
  const toggleStats = $('toggle-stats');
  const footerStatPages = $('footer-stat-pages');
  const footerStatWords = $('footer-stat-words');
  const sceneList = $('scene-list');
  const sceneCountBadge = $('scene-count-badge');
  const statPages = $('stat-pages');
  const statWords = $('stat-words');
  const statScenes = $('stat-scenes');
  const statRuntime = $('stat-runtime');
  const statDialogueWords = $('stat-dialogue-words');
  const registryTabButtons = document.querySelectorAll('.registry-section .tab-btn');
  const registryPanels = document.querySelectorAll('.registry-panel');
  const charactersRegistry = $('characters-registry');
  const locationsRegistry = $('locations-registry');
  const autocompleteBox = $('autocomplete-box');
  const shortcutHint = $('shortcut-hint');
  const saveStatus = $('save-status');
  const toastEl = $('toast');
  const metadataModal = $('metadata-modal');
  const metadataTitleInput = $('metadata-title-input');
  const metadataAuthorInput = $('metadata-author-input');
  const metadataContactInput = $('metadata-contact-input');

  // --- Constants ---
  const TYPES = ['scene-heading', 'action', 'character', 'parenthetical', 'dialogue', 'transition'];
  const DISPLAY_NAMES = {
    'scene-heading': 'Scene Heading', 'action': 'Action', 'character': 'Character',
    'parenthetical': 'Parenthetical', 'dialogue': 'Dialogue', 'transition': 'Transition'
  };
  const PLACEHOLDERS = {
    'scene-heading': 'INT. LOCATION - DAY', 'action': '', 'character': 'CHARACTER NAME',
    'parenthetical': 'attitude...', 'dialogue': 'Dialogue text...', 'transition': 'CUT TO:'
  };
  const ENTER_NEXT = {
    'scene-heading': 'action', 'action': 'action', 'character': 'dialogue',
    'dialogue': 'action', 'parenthetical': 'dialogue', 'transition': 'scene-heading'
  };
  const FULL_PAGE = 1104; // 1056px page + 48px gap, matches the CSS page guides
  const SCENE_PREFIX_RE = /^(INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/i;

  // --- State ---
  let activeBlock = null;
  let castList = new Set();
  let locationList = new Set();
  let autoSaveTimeout = null;
  let analysisTimeout = null;
  let currentScriptId = store.get('screenflow_current_id') || ('script_' + Date.now());
  let activeFileHandle = null;
  let suggestionIndex = -1;
  let currentSuggestions = [];
  let formatUndoStack = [];
  let formatRedoStack = [];
  let lastActionWasFormatChange = false;
  let quotaWarned = false;
  let toastTimer = null;
  let lastSceneSignature = null;
  let lastCastSignature = null;
  let lastLocationSignature = null;
  let lastRecentsSignature = null;

  function refreshIcons() { if (window.lucide) { try { lucide.createIcons(); } catch (e) {} } }
  function showToast(msg, ms = 2600) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  init();

  function init() {
    loadScriptFromLocalStorage();

    const savedTheme = store.get('screenflow_theme', 'dark-theme');
    document.documentElement.classList.remove('dark-theme', 'light-theme');
    document.documentElement.classList.add(savedTheme === 'light-theme' ? 'light-theme' : 'dark-theme');
    setThemeIcon(savedTheme === 'light-theme');

    if (store.get('screenflow_setting_highlights') === 'false' && toggleHighlights) {
      toggleHighlights.checked = false;
      editor.classList.add('disable-highlights');
    }
    if (store.get('screenflow_setting_spellcheck') === 'false' && toggleSpellcheck) {
      toggleSpellcheck.checked = false;
      editor.setAttribute('spellcheck', 'false');
    }
    if (store.get('screenflow_setting_registry') === 'false' && toggleRegistry) {
      toggleRegistry.checked = false;
      const reg = $('registry-section');
      if (reg) reg.style.display = 'none';
    }
    if (store.get('screenflow_setting_stats') === 'false' && toggleStats) {
      toggleStats.checked = false;
      setStatsVisible(false);
    }

    const savedZoom = parseFloat(store.get('screenflow_zoom', '1.0')) || 1.0;
    if (zoomSlider) zoomSlider.value = savedZoom;
    applyZoom(savedZoom);

    if (store.get('screenflow_sidebar_collapsed') === 'true') collapseSidebar(false);
    else if (store.get('screenflow_sidebar_collapsed') === null && window.innerWidth <= 1024) collapseSidebar(false); // first visit on a phone/tablet: land on the editor

    setupEventListeners();
    document.documentElement.classList.remove('sidebar-is-collapsed-init', 'disable-highlights-init', 'hide-stats-init');
    updateScriptAnalysis(true);
    highlightActiveLine();
    renderRecentsUI();
    setupDragAndDrop();
    refreshIcons();
  }

  function setThemeIcon(isLight) {
    const wrap = $('theme-toggle-icon-wrap');
    if (wrap) wrap.innerHTML = `<i data-lucide="${isLight ? 'moon' : 'sun'}" id="theme-toggle-icon"></i>`;
    if (themeToggleBtn) themeToggleBtn.setAttribute('title', isLight ? 'Switch to Dark Slate Theme' : 'Switch to Crisp Paper Theme');
    refreshIcons();
  }

  function applyZoom(val) {
    if (zoomSliderLabel) zoomSliderLabel.textContent = `${Math.round(val * 100)}%`;
    if (paperContainer) paperContainer.style.setProperty('--zoom-factor', String(val));
  }

  function setStatsVisible(show) {
    if (footerStatPages) footerStatPages.classList.toggle('hidden', !show);
    if (footerStatWords) footerStatWords.classList.toggle('hidden', !show);
    document.querySelectorAll('.workspace-footer .divider').forEach(d => { d.style.display = show ? '' : 'none'; });
    const sbStats = $('sidebar-stats');
    if (sbStats) sbStats.style.display = show ? '' : 'none';
  }

  // ================= Event listeners =================
  function setupEventListeners() {
    editor.addEventListener('keydown', handleEditorKeyDown);
    editor.addEventListener('keyup', handleEditorKeyUp);
    editor.addEventListener('click', handleEditorClick);
    editor.addEventListener('input', handleEditorInput);
    editor.addEventListener('blur', handleEditorBlur);
    editor.addEventListener('paste', handleEditorPaste);

    // Format picker (mousedown keeps editor focus)
    formatPickerBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const open = formatPickerDropdown.classList.toggle('show');
      formatPickerBtn.classList.toggle('open', open);
      formatPickerBtn.setAttribute('aria-expanded', String(open));
    });
    formatOptions.forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const type = btn.getAttribute('data-type');
        const target = getCurrentBlock() || activeBlock;
        if (target) { changeBlockType(target, type); editor.focus(); }
        formatPickerDropdown.classList.remove('show');
        formatPickerBtn.classList.remove('open');
        formatPickerBtn.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('mousedown', (e) => {
      if (!formatPickerBtn.contains(e.target) && !formatPickerDropdown.contains(e.target)) {
        formatPickerDropdown.classList.remove('show');
        formatPickerBtn.classList.remove('open');
        formatPickerBtn.setAttribute('aria-expanded', 'false');
      }
    });

    themeToggleBtn.addEventListener('click', toggleTheme);
    toggleSidebarBtn.addEventListener('click', () => collapseSidebar(true));
    expandSidebarBtn.addEventListener('click', expandSidebar);
    if (sidebarScrim) sidebarScrim.addEventListener('click', () => collapseSidebar(true));

    helpToggleBtn.addEventListener('click', () => { helpModal.classList.add('active'); });
    $('close-modal-btn').addEventListener('click', closeHelpModal);
    $('close-modal-footer-btn').addEventListener('click', closeHelpModal);
    helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeHelpModal(); });

    // Metadata modal
    $('metadata-modal-btn').addEventListener('click', () => {
      metadataTitleInput.value = store.get(`screenflow_meta_title_${currentScriptId}`, '') || scriptTitleInput.value;
      metadataAuthorInput.value = store.get(`screenflow_meta_author_${currentScriptId}`, '');
      metadataContactInput.value = store.get(`screenflow_meta_contact_${currentScriptId}`, '');
      metadataModal.classList.add('active');
      setTimeout(() => metadataTitleInput.focus(), 50);
    });
    const closeMetadata = () => metadataModal.classList.remove('active');
    $('close-metadata-modal-btn').addEventListener('click', closeMetadata);
    metadataModal.addEventListener('click', (e) => { if (e.target === metadataModal) closeMetadata(); });
    $('save-metadata-modal-btn').addEventListener('click', () => {
      store.set(`screenflow_meta_title_${currentScriptId}`, metadataTitleInput.value);
      store.set(`screenflow_meta_author_${currentScriptId}`, metadataAuthorInput.value);
      store.set(`screenflow_meta_contact_${currentScriptId}`, metadataContactInput.value);
      if (metadataTitleInput.value.trim() !== '') {
        scriptTitleInput.value = metadataTitleInput.value;
        triggerAutoSave();
      }
      closeMetadata();
      showToast('Title page saved');
    });

    if (btnExportPdf) btnExportPdf.addEventListener('click', () => { closeMenu(); saveAsPDF(); });
    btnExportFountain.addEventListener('click', exportFountainText);
    if (btnOpenScript) btnOpenScript.addEventListener('click', () => { closeMenu(); importFountainText(); });
    if (importFountainFile) importFountainFile.addEventListener('change', handleFallbackFileImport);
    if (btnNewScript) btnNewScript.addEventListener('click', () => { closeMenu(); createNewScript(); });
    if (btnFindOpen) btnFindOpen.addEventListener('click', () => { closeMenu(); openFindBar(); });
    if (btnPrint) btnPrint.addEventListener('click', () => { closeMenu(); window.print(); });

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menuDropdown.classList.toggle('show');
      menuBtn.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!menuDropdown.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) closeMenu();
    });

    toggleHighlights.addEventListener('change', () => {
      editor.classList.toggle('disable-highlights', !toggleHighlights.checked);
      store.set('screenflow_setting_highlights', String(toggleHighlights.checked));
    });
    toggleSpellcheck.addEventListener('change', () => {
      editor.setAttribute('spellcheck', String(toggleSpellcheck.checked));
      store.set('screenflow_setting_spellcheck', String(toggleSpellcheck.checked));
    });
    toggleRegistry.addEventListener('change', () => {
      const reg = $('registry-section');
      if (reg) reg.style.display = toggleRegistry.checked ? '' : 'none';
      store.set('screenflow_setting_registry', String(toggleRegistry.checked));
    });
    if (toggleStats) toggleStats.addEventListener('change', () => {
      setStatsVisible(toggleStats.checked);
      store.set('screenflow_setting_stats', String(toggleStats.checked));
    });

    registryTabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        registryTabButtons.forEach(b => b.classList.remove('active'));
        registryPanels.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = $(`${btn.getAttribute('data-tab')}-panel`);
        if (panel) panel.classList.add('active');
      });
    });

    scriptTitleInput.addEventListener('input', triggerAutoSave);
    scriptTitleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); scriptTitleInput.blur(); editor.focus(); }
    });

    // Zoom: 50%-200% now (v1 could not go below 100%, so the paper could
    // never be shrunk to fit a small screen). Snaps on release.
    if (zoomSlider) {
      zoomSlider.addEventListener('input', (e) => applyZoom(parseFloat(e.target.value)));
      zoomSlider.addEventListener('change', (e) => {
        let v = parseFloat(e.target.value);
        for (const snap of [1.0, 1.5, 2.0]) if (Math.abs(v - snap) <= 0.06) v = snap;
        zoomSlider.value = v;
        applyZoom(v);
        store.set('screenflow_zoom', String(v));
      });
    }

    // Global keys: save, find, escape
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); exportFountainText(); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openFindBar(); }
      else if (e.key === 'Escape') {
        closeMenu();
        closeAutocomplete();
        helpModal.classList.remove('active');
        metadataModal.classList.remove('active');
        formatPickerDropdown.classList.remove('show');
        const fb = $('find-bar');
        if (fb && !fb.hidden) closeFindBar();
      }
    });

    // Flush pending autosave instead of losing the last keystrokes
    window.addEventListener('beforeunload', flushAutoSave);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAutoSave(); });

    setupFindBar();
    setupSidebarResizer();
    const sceneListWrapper = document.querySelector('.scene-list-wrapper');
    if (sceneListWrapper) makeResizable(sceneListWrapper);
    registryPanels.forEach(panel => makeResizable(panel));
  }

  function closeMenu() {
    menuDropdown.classList.remove('show');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  function closeHelpModal() { helpModal.classList.remove('active'); editor.focus(); }

  // Sidebar width: Pointer Events unify mouse + touch (v1 was mouse-only)
  function setupSidebarResizer() {
    const resizer = $('sidebar-width-resizer');
    if (!resizer) return;
    const saved = store.get('screenflow_sidebar_width');
    if (saved) document.documentElement.style.setProperty('--sidebar-width', saved);
    let resizing = false, startX = 0, startWidth = 0;
    resizer.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#toggle-sidebar-btn')) return;
      resizing = true; startX = e.clientX;
      startWidth = parseInt(getComputedStyle(sidebar).width, 10);
      sidebar.style.transition = 'none';
      document.body.style.cursor = 'ew-resize';
      e.preventDefault();
    });
    document.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const w = Math.max(180, Math.min(560, startWidth + (e.clientX - startX)));
      document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
    });
    document.addEventListener('pointerup', () => {
      if (!resizing) return;
      resizing = false;
      document.body.style.cursor = '';
      sidebar.style.transition = '';
      store.set('screenflow_sidebar_width', document.documentElement.style.getPropertyValue('--sidebar-width'));
    });
  }

  function makeResizable(element) {
    let resizing = false, startY = 0, startHeight = 0;
    const ZONE = 10;
    const storageKey = element.id ? `screenflow_resizer_${element.id}` :
      (element.classList.contains('scene-list-wrapper') ? 'screenflow_resizer_scene-list' : null);
    if (storageKey) {
      const savedHeight = store.get(storageKey);
      if (savedHeight) element.style.height = savedHeight;
    }
    element.addEventListener('pointermove', (e) => {
      if (resizing) return;
      const rect = element.getBoundingClientRect();
      element.style.cursor = (e.clientY >= rect.bottom - ZONE && e.clientY <= rect.bottom) ? 'ns-resize' : '';
    });
    element.addEventListener('pointerdown', (e) => {
      const rect = element.getBoundingClientRect();
      if (e.clientY >= rect.bottom - ZONE && e.clientY <= rect.bottom) {
        resizing = true; startY = e.clientY;
        startHeight = parseInt(getComputedStyle(element).height, 10);
        document.body.style.cursor = 'ns-resize';
        e.preventDefault();
      }
    });
    document.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      element.style.height = `${Math.max(50, startHeight + (e.clientY - startY))}px`;
    });
    document.addEventListener('pointerup', () => {
      if (!resizing) return;
      resizing = false;
      document.body.style.cursor = '';
      if (storageKey) store.set(storageKey, element.style.height);
    });
  }

  // ================= Editor core =================
  function getElementType(block) {
    if (!block || !block.classList) return 'action';
    for (const t of TYPES) if (block.classList.contains(t)) return t;
    return 'action';
  }
  function getParagraphAncestor(node) {
    let curr = node;
    while (curr && curr !== editor) {
      if (curr.nodeName === 'P' && curr.classList && curr.classList.contains('element')) return curr;
      curr = curr.parentNode;
    }
    return null;
  }
  function getCurrentBlock() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    return getParagraphAncestor(sel.getRangeAt(0).startContainer);
  }
  function makeBlock(type, text = '') {
    const p = document.createElement('p');
    p.className = `element ${type}`;
    p.setAttribute('placeholder', PLACEHOLDERS[type] || '');
    if (text) p.textContent = text;
    return p;
  }
  function setCaret(block, offset) {
    const sel = window.getSelection();
    const range = document.createRange();
    if (!block.firstChild) { range.setStart(block, 0); }
    else {
      // Walk text nodes to the requested character offset
      let remaining = offset;
      let placed = false;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (remaining <= node.textContent.length) { range.setStart(node, remaining); placed = true; break; }
        remaining -= node.textContent.length;
      }
      if (!placed) { range.selectNodeContents(block); range.collapse(false); }
      else range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range); return;
    }
    range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
  }
  function caretOffsetIn(block) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return 0;
    const range = sel.getRangeAt(0);
    if (!block.contains(range.startContainer)) return 0;
    const pre = range.cloneRange();
    pre.selectNodeContents(block);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString().length;
  }

  function handleEditorKeyDown(e) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const block = getParagraphAncestor(sel.getRangeAt(0).startContainer);
    if (!block) return;
    activeBlock = block;
    const mod = e.ctrlKey || e.metaKey;

    // Autocomplete popup keys first
    if (autocompleteBox.style.display === 'block') {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigateSuggestions(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); navigateSuggestions(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptSuggestion(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAutocomplete(); return; }
    }

    // Format undo/redo: only intercepts when the immediately preceding
    // action was a format change, so it never eats the browser's text undo.
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      if (lastActionWasFormatChange && formatUndoStack.length) {
        const top = formatUndoStack[formatUndoStack.length - 1];
        if (editor.contains(top.block)) {
          e.preventDefault();
          formatUndoStack.pop();
          applyBlockType(top.block, top.oldType);
          formatRedoStack.push(top);
          lastActionWasFormatChange = formatRedoStack.length > 0;
          afterStructureChange(top.block);
          return;
        }
        formatUndoStack.pop();
      }
      return; // otherwise let the browser undo text natively
    }
    if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) {
      if (formatRedoStack.length) {
        const top = formatRedoStack[formatRedoStack.length - 1];
        if (editor.contains(top.block)) {
          e.preventDefault();
          formatRedoStack.pop();
          applyBlockType(top.block, top.newType);
          formatUndoStack.push(top);
          lastActionWasFormatChange = true;
          afterStructureChange(top.block);
          return;
        }
        formatRedoStack.pop();
      }
      return;
    }

    // Ctrl/Cmd + 1-6 format hotkeys
    if (mod && ['1','2','3','4','5','6'].includes(e.key)) {
      e.preventDefault();
      changeBlockType(block, TYPES[parseInt(e.key, 10) - 1]);
      return;
    }
    if (mod) return; // leave other browser shortcuts alone

    if (e.key === 'Enter') {
      e.preventDefault();
      handleSmartEnter(block, sel);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const idx = TYPES.indexOf(getElementType(block));
      const next = TYPES[(idx + (e.shiftKey ? TYPES.length - 1 : 1)) % TYPES.length];
      changeBlockType(block, next);
      return;
    }
    if (e.key === 'Backspace' && sel.isCollapsed) {
      if (handleBackspace(block)) { e.preventDefault(); return; }
    }
    if (e.key === 'Delete' && sel.isCollapsed) {
      if (handleForwardDelete(block)) { e.preventDefault(); return; }
    }
  }

  // Returns true when handled (native deletion must be skipped)
  function handleBackspace(block) {
    const text = block.textContent;
    const offset = caretOffsetIn(block);
    if (text.trim() === '') {
      if (getElementType(block) !== 'action') { changeBlockType(block, 'action'); return true; }
      const prev = block.previousElementSibling;
      if (prev && prev.classList.contains('element')) {
        const target = prev;
        block.remove();
        editor.focus();
        setCaret(target, target.textContent.length);
        afterStructureChange(target);
        return true;
      }
      return true; // first empty block: swallow instead of deleting the only block
    }
    if (offset === 0) {
      const prev = block.previousElementSibling;
      if (prev && prev.classList.contains('element')) {
        const junction = prev.textContent.length;
        prev.textContent = prev.textContent + text;
        block.remove();
        editor.focus();
        setCaret(prev, junction);
        afterStructureChange(prev);
        return true;
      }
    }
    return false;
  }

  function handleForwardDelete(block) {
    const offset = caretOffsetIn(block);
    if (offset < block.textContent.length) return false;
    const next = block.nextElementSibling;
    if (next && next.classList.contains('element')) {
      block.textContent = block.textContent + next.textContent;
      next.remove();
      editor.focus();
      setCaret(block, offset);
      afterStructureChange(block);
      return true;
    }
    return false;
  }

  function handleSmartEnter(block, sel) {
    const type = getElementType(block);
    // Enter on an empty non-action block: step back to Action, don't stack blanks
    if (block.textContent.trim() === '' && type !== 'action') {
      changeBlockType(block, 'action');
      return;
    }
    const nextType = ENTER_NEXT[type] || 'action';
    const range = sel.getRangeAt(0);
    const after = range.cloneRange();
    after.selectNodeContents(block);
    after.setStart(range.startContainer, range.startOffset);
    const movingText = after.toString();
    after.deleteContents();
    // If text was split off, the remainder starts the new block
    const newBlock = makeBlock(nextType, movingText);
    block.parentNode.insertBefore(newBlock, block.nextSibling);
    editor.focus();
    setCaret(newBlock, 0);
    activeBlock = newBlock;
    newBlock.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    afterStructureChange(newBlock);
  }

  function applyBlockType(block, type) {
    let text = block.textContent;
    if (type === 'parenthetical') text = text.replace(/^\(+|\)+$/g, '');
    const offset = caretOffsetIn(block);
    const hadFocus = !!getCurrentBlock() && getCurrentBlock() === block;
    block.textContent = text;
    block.className = `element ${type}`;
    block.setAttribute('placeholder', PLACEHOLDERS[type] || '');
    block.style.cssText = '';
    if (hadFocus) { editor.focus(); setCaret(block, Math.min(offset, text.length)); }
  }

  function changeBlockType(block, type, opts = {}) {
    if (!block) return;
    const prevType = getElementType(block);
    if (prevType === type) return;
    if (opts.history !== false) {
      formatUndoStack.push({ block, oldType: prevType, newType: type });
      if (formatUndoStack.length > 100) formatUndoStack.shift();
      formatRedoStack = [];
      lastActionWasFormatChange = true;
    }
    applyBlockType(block, type);
    afterStructureChange(block);
  }

  function afterStructureChange(block) {
    highlightActiveLine();
    scheduleAnalysis();
    triggerAutoSave();
    if (block) activeBlock = block;
  }

  function handleEditorKeyUp() {
    highlightActiveLine();
    handleAutocompleteSearch();
  }
  function handleEditorClick() {
    highlightActiveLine();
    closeAutocomplete();
  }
  function handleEditorInput() {
    lastActionWasFormatChange = false;
    // Auto-convert a freshly typed INT./EXT. action line into a scene heading.
    // history:false is explicit here; v1 passed its isUndo flag and silently
    // pushed these conversions onto the redo stack.
    const block = getCurrentBlock();
    if (block && getElementType(block) === 'action') {
      const text = block.textContent.trim().toUpperCase();
      if (SCENE_PREFIX_RE.test(text) && text.length > 4) {
        applyBlockType(block, 'scene-heading');
      }
    }
    scheduleAnalysis();
    triggerAutoSave();
  }
  function handleEditorBlur() {
    closeAutocomplete();
    normalizeEditorStructure();
    document.querySelectorAll('.paper .element.active-line').forEach(el => el.classList.remove('active-line'));
    flushAutoSave();
  }

  function normalizeEditorStructure() {
    if (!editor.children.length || editor.innerHTML.trim() === '') {
      editor.replaceChildren(makeBlock('action'));
      return;
    }
    const current = getCurrentBlock();
    Array.from(editor.childNodes).forEach(node => {
      if (node === current) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim() !== '') {
          const p = makeBlock('action', node.textContent);
          editor.replaceChild(p, node);
        } else editor.removeChild(node);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.nodeName === 'BR') { editor.removeChild(node); return; }
        if (node.classList && node.classList.contains('page-number-indicator')) { editor.removeChild(node); return; }
        if (node.nodeName === 'DIV' || (node.nodeName === 'P' && !(node.classList && node.classList.contains('element')))) {
          let type = 'action';
          const cls = (node.className || '').toLowerCase();
          if (cls.includes('scene') || cls.includes('heading') || cls.includes('slug')) type = 'scene-heading';
          else if (cls.includes('character') || cls.includes('char')) type = 'character';
          else if (cls.includes('parenthetical') || cls.includes('paren')) type = 'parenthetical';
          else if (cls.includes('dialogue') || cls.includes('dialog')) type = 'dialogue';
          else if (cls.includes('transition')) type = 'transition';
          const p = makeBlock(type, node.textContent);
          editor.replaceChild(p, node);
        }
      }
    });
    if (!editor.querySelector('.element')) editor.replaceChildren(makeBlock('action'));
  }

  function highlightActiveLine() {
    const current = getCurrentBlock();
    document.querySelectorAll('.paper .element.active-line').forEach(el => {
      if (el !== current) el.classList.remove('active-line');
    });
    if (current) {
      activeBlock = current;
      current.classList.add('active-line');
      updateUIIndicators(getElementType(current));
    }
  }

  function updateUIIndicators(type) {
    if (formatPickerLabel) formatPickerLabel.textContent = DISPLAY_NAMES[type] || 'Action';
    formatOptions.forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-type') === type));
    const hints = {
      'scene-heading': 'Press <kbd>Enter</kbd> to write Action.',
      'action': 'Press <kbd>Tab</kbd> to switch to Character.',
      'character': 'Press <kbd>Enter</kbd> for Dialogue, <kbd>Tab</kbd> for Parenthetical.',
      'parenthetical': 'Press <kbd>Enter</kbd> to continue Dialogue.',
      'dialogue': 'Press <kbd>Enter</kbd> for Action, <kbd>Tab</kbd> for Transition.',
      'transition': 'Press <kbd>Enter</kbd> to start a new Scene Heading.'
    };
    if (shortcutHint) shortcutHint.innerHTML = hints[type] || '';
  }

  // ================= Autocomplete =================
  function handleAutocompleteSearch() {
    if (!activeBlock || !editor.contains(activeBlock)) return closeAutocomplete();
    const type = getElementType(activeBlock);
    const text = activeBlock.textContent.trim().toUpperCase();
    if (text.length < 1) return closeAutocomplete();
    let matches = [];
    if (type === 'character') {
      matches = Array.from(castList).filter(n => n.startsWith(text) && n !== text);
    } else if (type === 'transition') {
      matches = ['CUT TO:', 'SMASH CUT TO:', 'MATCH CUT TO:', 'FADE OUT.', 'FADE IN:', 'DISSOLVE TO:']
        .filter(t => t.startsWith(text) && t !== text);
    } else if (type === 'scene-heading') {
      const prefixes = ['INT.', 'EXT.', 'INT/EXT.', 'I/E.', 'EST.'];
      const prefix = prefixes.find(p => text.startsWith(p));
      if (prefix) {
        const rest = text.substring(prefix.length).trim();
        if (rest.length > 0 && !rest.includes(' - ')) {
          matches = Array.from(locationList).filter(l => l.startsWith(rest) && l !== rest).map(l => `${prefix} ${l}`);
        } else if (rest.includes(' - ')) {
          const tail = text.substring(text.lastIndexOf('-') + 1).trim();
          matches = ['DAY', 'NIGHT', 'DAWN', 'DUSK', 'CONTINUOUS', 'LATER', 'MOMENTS LATER']
            .filter(t => t.startsWith(tail) && t !== tail)
            .map(t => text.substring(0, text.lastIndexOf('-') + 1) + ' ' + t);
        }
      } else {
        matches = prefixes.filter(p => p.startsWith(text));
      }
    }
    if (matches.length) showAutocomplete(matches.slice(0, 8)); else closeAutocomplete();
  }

  function showAutocomplete(suggestions) {
    currentSuggestions = suggestions;
    suggestionIndex = 0;
    autocompleteBox.replaceChildren();
    suggestions.forEach((s, idx) => {
      const li = document.createElement('li');
      li.className = `autocomplete-item${idx === 0 ? ' selected' : ''}`;
      li.textContent = s;
      li.setAttribute('role', 'option');
      li.addEventListener('mousedown', (e) => { e.preventDefault(); suggestionIndex = idx; acceptSuggestion(); });
      autocompleteBox.appendChild(li);
    });
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    // position:fixed: the caret rect is already viewport-relative.
    // (v1 added window.scrollX/Y on top, so the box drifted when the
    // editor viewport, not the window, was the scrolled element.)
    const width = 230;
    autocompleteBox.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    autocompleteBox.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 190)}px`;
    autocompleteBox.style.display = 'block';
  }
  function navigateSuggestions(dir) {
    const items = autocompleteBox.querySelectorAll('.autocomplete-item');
    if (!items.length) return;
    items[suggestionIndex]?.classList.remove('selected');
    suggestionIndex = (suggestionIndex + dir + items.length) % items.length;
    items[suggestionIndex].classList.add('selected');
    items[suggestionIndex].scrollIntoView({ block: 'nearest' });
  }
  function acceptSuggestion() {
    if (!activeBlock || suggestionIndex < 0 || suggestionIndex >= currentSuggestions.length) return closeAutocomplete();
    const val = currentSuggestions[suggestionIndex];
    activeBlock.textContent = val;
    editor.focus();
    setCaret(activeBlock, val.length);
    closeAutocomplete();
    scheduleAnalysis();
    triggerAutoSave();
  }
  function closeAutocomplete() {
    autocompleteBox.style.display = 'none';
    currentSuggestions = [];
    suggestionIndex = -1;
  }

  // ================= Plain-text / Fountain parsing (shared) =================
  // Classifies raw lines into screenplay blocks. Used by Fountain import,
  // drag-and-drop, and plain-text paste, so all three behave identically.
  function parseLinesToBlocks(lines) {
    const blocks = [];
    let inDialogue = false;
    const hasIndents = lines.some(l => l.trim().length > 0 && /^\s{6,}/.test(l));
    const nextNonEmpty = (from) => {
      for (let j = from; j < lines.length; j++) if (lines[j].trim() !== '') return lines[j].trim();
      return '';
    };
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (line === '') { inDialogue = false; continue; }
      // Fountain markup we intentionally skip / unwrap
      if (line.startsWith('[[')) continue;                 // notes
      if (line.startsWith('#')) continue;                  // sections
      if (line.startsWith('=')) continue;                  // synopses / page breaks
      if (line.startsWith('/*')) continue;                 // boneyard start (single-line handling)
      let type = 'action';
      let text = line;
      if (line.startsWith('.') && !line.startsWith('..') && line.length > 1 && /[A-Za-z]/.test(line[1])) {
        type = 'scene-heading'; text = line.substring(1).trim().toUpperCase(); inDialogue = false;
      } else if (line.startsWith('@')) {
        type = 'character'; text = line.substring(1).trim(); inDialogue = true;
      } else if (line.startsWith('!')) {
        type = 'action'; text = line.substring(1); inDialogue = false;
      } else if (line.startsWith('>')) {
        const inner = line.substring(1).trim();
        if (inner.endsWith('<')) { type = 'action'; text = inner.slice(0, -1).trim(); } // centered text -> action
        else { type = 'transition'; text = inner.toUpperCase(); }
        inDialogue = false;
      } else if (SCENE_PREFIX_RE.test(line)) {
        type = 'scene-heading'; text = line.toUpperCase(); inDialogue = false;
      } else if (/^[A-Z][A-Z\s'’.-]+ TO:$/.test(line) || /^(FADE OUT\.?|FADE IN:?|CUT TO:|DISSOLVE TO:)$/i.test(line)) {
        type = 'transition'; text = line.toUpperCase(); inDialogue = false;
      } else if (line.startsWith('(') && line.endsWith(')')) {
        type = 'parenthetical'; text = line.slice(1, -1).trim();
      } else if (line.startsWith('~')) {
        type = 'dialogue'; text = line.substring(1);
      } else if (hasIndents) {
        const indent = (raw.match(/^\s*/) || [''])[0].length;
        const isUpper = line === line.toUpperCase() && /[A-Z]/.test(line);
        if (indent >= 28 && isUpper) { type = 'transition'; inDialogue = false; }
        else if (indent >= 14 && isUpper && line.length < 40) { type = 'character'; inDialogue = true; }
        else if (inDialogue || (indent >= 5 && indent < 22)) { type = 'dialogue'; }
        else { type = 'action'; inDialogue = false; }
      } else {
        const isUpper = line === line.toUpperCase() && /[A-Z]/.test(line) && line.length < 40 && !/^[0-9.\-#\s]+$/.test(line);
        if (isUpper && nextNonEmpty(i + 1) !== '') { type = 'character'; inDialogue = true; }
        else if (inDialogue) { type = 'dialogue'; }
        else { type = 'action'; }
      }
      blocks.push({ type, text });
    }
    return blocks;
  }

  function insertBlocksAtCaret(blocks) {
    if (!blocks.length) return;
    const sel = window.getSelection();
    let current = getCurrentBlock();
    if (!current) {
      blocks.forEach(b => editor.appendChild(makeBlock(b.type, b.text)));
      const last = editor.lastElementChild;
      editor.focus(); if (last) setCaret(last, last.textContent.length);
      return;
    }
    // Split the current block at the caret; pasted blocks go in between.
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    let tailText = '';
    if (range) {
      const after = range.cloneRange();
      after.selectNodeContents(current);
      after.setStart(range.startContainer, range.startOffset);
      tailText = after.toString();
      after.deleteContents();
    }
    let insertAfter = current;
    let lastInserted = null;
    // If the current block is empty, reuse it for the first pasted block
    if (current.textContent.trim() === '' && blocks.length) {
      applyBlockType(current, blocks[0].type);
      current.textContent = blocks[0].text;
      lastInserted = current;
      blocks = blocks.slice(1);
    }
    blocks.forEach(b => {
      const p = makeBlock(b.type, b.text);
      insertAfter.parentNode.insertBefore(p, insertAfter.nextSibling);
      insertAfter = p;
      lastInserted = p;
    });
    if (tailText) {
      const tail = makeBlock(getElementType(current) === 'scene-heading' ? 'action' : getElementType(current), tailText);
      insertAfter.parentNode.insertBefore(tail, insertAfter.nextSibling);
      lastInserted = tail;
    }
    if (lastInserted) {
      editor.focus();
      setCaret(lastInserted, tailText ? 0 : lastInserted.textContent.length);
      lastInserted.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function handleEditorPaste(e) {
    e.preventDefault();
    const clipboard = e.clipboardData || window.clipboardData;
    const htmlText = clipboard.getData('text/html');
    const plainText = clipboard.getData('text/plain') || '';
    let blocks = [];

    if (htmlText) {
      const doc = new DOMParser().parseFromString(htmlText, 'text/html');
      const leafBlocks = Array.from(doc.body.querySelectorAll('*')).filter(el => {
        if (!['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(el.nodeName)) return false;
        if (el.textContent.trim() === '') return false;
        return el.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6').length === 0;
      });
      if (leafBlocks.length) {
        // Classify with the shared parser over the extracted texts so HTML
        // and plain pastes agree, then upgrade types from source classes.
        blocks = parseLinesToBlocks(leafBlocks.map(el => el.textContent.trim()));
        leafBlocks.forEach((el, idx) => {
          if (!blocks[idx]) return;
          let chain = '', curr = el;
          while (curr && curr !== doc.body) { chain += ' ' + (curr.className || ''); curr = curr.parentNode; }
          const cls = chain.toLowerCase();
          if (/scene|heading|slug/.test(cls)) blocks[idx].type = 'scene-heading';
          else if (/character|\bchar\b/.test(cls)) blocks[idx].type = 'character';
          else if (/paren/.test(cls)) blocks[idx].type = 'parenthetical';
          else if (/dialog/.test(cls)) blocks[idx].type = 'dialogue';
          else if (/transition/.test(cls)) blocks[idx].type = 'transition';
        });
      }
    }
    if (!blocks.length && plainText) blocks = parseLinesToBlocks(plainText.split(/\r?\n/));
    if (!blocks.length) return;
    insertBlocksAtCaret(blocks);
    normalizeEditorStructure();
    afterStructureChange(getCurrentBlock());
  }

  // ================= Analysis (debounced, cached) =================
  function scheduleAnalysis() {
    clearTimeout(analysisTimeout);
    analysisTimeout = setTimeout(() => updateScriptAnalysis(false), 250);
  }

  function updateScriptAnalysis(immediate = false) {
    if (!immediate) { /* called via debounce or directly for structural ops */ }
    const paragraphs = editor.querySelectorAll('.element');
    let sceneCount = 0, wordCount = 0, dialogueWords = 0;
    const newCast = new Set();
    const newLocations = new Set();
    const scenes = [];

    paragraphs.forEach(p => {
      const text = p.textContent.trim();
      const type = getElementType(p);
      if (text) {
        const words = text.split(/\s+/).length;
        wordCount += words;
        if (type === 'dialogue') dialogueWords += words;
      }
      if (type === 'scene-heading') {
        sceneCount++;
        scenes.push({ el: p, num: sceneCount, title: text.toUpperCase() || 'UNTITLED SCENE' });
        const m = text.match(/^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)\s*(.+)$/i);
        if (m && m[1].trim()) newLocations.add(m[1].trim().toUpperCase());
      }
      if (type === 'character' && text) newCast.add(text.toUpperCase());
    });

    castList = newCast;
    locationList = newLocations;
    sceneCountBadge.textContent = sceneCount;
    statWords.textContent = wordCount.toLocaleString();
    if (statScenes) statScenes.textContent = sceneCount;
    if (statDialogueWords) statDialogueWords.textContent = dialogueWords.toLocaleString();
    // Page estimate from the real rendered height and the true page unit.
    const pages = Math.max(1, Math.ceil(editor.scrollHeight / FULL_PAGE));
    statPages.textContent = pages;
    if (statRuntime) statRuntime.textContent = pages >= 60 ? `${Math.floor(pages / 60)}h ${pages % 60}m` : `${pages} min`;

    // Only rebuild the sidebar lists when their contents actually changed;
    // v1 rebuilt them (and reset scroll) on every single keystroke.
    const sceneSig = scenes.map(s => s.title).join('|');
    if (sceneSig !== lastSceneSignature) {
      lastSceneSignature = sceneSig;
      sceneList.replaceChildren();
      if (!scenes.length) {
        const li = document.createElement('li');
        li.className = 'empty-outline-msg';
        li.textContent = 'Add a Scene Heading (e.g. INT. HALLWAY - DAY) to start mapping your outline.';
        sceneList.appendChild(li);
      } else {
        scenes.forEach(s => {
          const li = document.createElement('li');
          li.className = 'scene-item';
          li.textContent = `${s.num}. ${s.title}`;
          li.title = `Scroll to scene ${s.num}: ${s.title}`;
          li.addEventListener('click', () => {
            s.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            s.el.classList.add('flash-highlight');
            setTimeout(() => s.el.classList.remove('flash-highlight'), 800);
            if (window.innerWidth <= 1024) collapseSidebar(true);
          });
          sceneList.appendChild(li);
        });
      }
    }

    const castSig = Array.from(newCast).join('|');
    if (castSig !== lastCastSignature) {
      lastCastSignature = castSig;
      charactersRegistry.replaceChildren();
      if (newCast.size) newCast.forEach(name => charactersRegistry.appendChild(registryItem(name)));
      else charactersRegistry.appendChild(emptyRegistryItem('No characters detected yet.'));
    }
    const locSig = Array.from(newLocations).join('|');
    if (locSig !== lastLocationSignature) {
      lastLocationSignature = locSig;
      locationsRegistry.replaceChildren();
      if (newLocations.size) newLocations.forEach(loc => locationsRegistry.appendChild(registryItem(loc)));
      else locationsRegistry.appendChild(emptyRegistryItem('No locations detected yet.'));
    }
  }
  function registryItem(label) {
    const li = document.createElement('li');
    li.className = 'registry-item';
    const span = document.createElement('span');
    span.textContent = label; // textContent, never innerHTML: names are user text
    li.appendChild(span);
    return li;
  }
  function emptyRegistryItem(msg) {
    const li = document.createElement('li');
    li.className = 'empty-msg';
    li.textContent = msg;
    return li;
  }

  // ================= Autosave =================
  function triggerAutoSave() {
    saveStatus.textContent = 'Saving...';
    saveStatus.classList.remove('status-success', 'status-error');
    saveStatus.classList.add('status-saving');
    saveStatus.style.opacity = '1';
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => { saveScriptToLocalStorage(); showSaveFlash('Auto-Saved'); }, 900);
  }
  function flushAutoSave() {
    if (autoSaveTimeout) { clearTimeout(autoSaveTimeout); autoSaveTimeout = null; saveScriptToLocalStorage(); }
  }
  function showSaveFlash(msg) {
    saveStatus.textContent = msg;
    saveStatus.classList.remove('status-saving', 'status-error');
    saveStatus.classList.add('status-success');
    saveStatus.style.opacity = '1';
    setTimeout(() => { saveStatus.style.opacity = '0.7'; }, 2000);
  }
  function saveScriptToLocalStorage() {
    const title = scriptTitleInput.value || 'Untitled Screenplay';
    const content = editor.innerHTML;
    const ok = store.set('screenflow_script_' + currentScriptId, content);
    store.set('screenflow_title_' + currentScriptId, title);
    store.set('screenflow_title', title);
    store.set('screenflow_script', content);
    if (!ok) {
      saveStatus.textContent = 'Storage full - export a .fountain backup';
      saveStatus.classList.remove('status-saving', 'status-success');
      saveStatus.classList.add('status-error');
      if (!quotaWarned) { quotaWarned = true; showToast('Browser storage is full. Export a .fountain backup so you do not lose work.', 5000); }
    }
    updateRecentsList(currentScriptId, title);
    if (activeFileHandle) writeFountainToHandle(activeFileHandle);
  }
  function buildFountainText() {
    const title = (scriptTitleInput.value || 'Untitled Screenplay').trim();
    const metaAuthor = store.get(`screenflow_meta_author_${currentScriptId}`, '');
    const metaContact = store.get(`screenflow_meta_contact_${currentScriptId}`, '');
    let out = `Title: ${title}\n`;
    if (metaAuthor.trim()) out += `Author: ${metaAuthor.trim()}\n`;
    if (metaContact.trim()) {
      const lines = metaContact.trim().split(/\r?\n/);
      out += `Contact:\n${lines.map(l => '   ' + l).join('\n')}\n`;
    }
    out += '\n';
    let prevType = '';
    editor.querySelectorAll('.element').forEach(p => {
      const type = getElementType(p);
      const text = p.textContent.trim();
      if (!text) return;
      switch (type) {
        case 'scene-heading': out += `\n${text.toUpperCase()}\n`; break;
        case 'character': out += `\n${text.toUpperCase()}\n`; break;
        case 'parenthetical': out += `(${text.replace(/^\(|\)$/g, '')})\n`; break;
        case 'dialogue': out += `${text}\n`; break;
        case 'transition': out += `\n> ${text.toUpperCase()}\n`; break;
        default: out += `\n${text}\n`;
      }
      prevType = type;
    });
    return out.replace(/\n{3,}/g, '\n\n');
  }
  function writeFountainToHandle(handle) {
    handle.createWritable()
      .then(w => w.write(buildFountainText()).then(() => w.close()))
      .then(() => {
        saveStatus.textContent = 'Synced to Disk';
        saveStatus.classList.remove('status-saving', 'status-error');
        saveStatus.classList.add('status-success');
      })
      .catch(err => console.error('Continuous auto-save write failed:', err));
  }

  function loadScriptFromLocalStorage() {
    if (!store.get('screenflow_title_' + currentScriptId) && store.get('screenflow_script')) {
      const legacyTitle = store.get('screenflow_title', 'Untitled Screenplay');
      store.set('screenflow_title_' + currentScriptId, legacyTitle);
      store.set('screenflow_script_' + currentScriptId, store.get('screenflow_script'));
      updateRecentsList(currentScriptId, legacyTitle);
    }
    const savedTitle = store.get('screenflow_title_' + currentScriptId);
    const savedScript = store.get('screenflow_script_' + currentScriptId);
    if (savedTitle !== null) scriptTitleInput.value = savedTitle;
    if (savedScript !== null && savedScript.trim() !== '') {
      editor.innerHTML = savedScript;
      editor.querySelectorAll('.element').forEach(el => {
        el.style.marginTop = '';
        if (el.dataset.pageBreak) delete el.dataset.pageBreak;
      });
      editor.querySelectorAll('.page-number-indicator').forEach(el => el.remove());
      normalizeEditorStructure();
    }
  }

  // ================= Fountain export / import =================
  async function exportFountainText() {
    flushAutoSave();
    const title = (scriptTitleInput.value || 'Untitled Screenplay').trim();
    const fountainOutput = buildFountainText();
    if (window.showSaveFilePicker) {
      try {
        let handle = activeFileHandle;
        if (!handle) {
          const opts = {
            suggestedName: `${title}.fountain`,
            types: [{ description: 'Fountain Screenplay', accept: { 'text/plain': ['.fountain', '.txt'] } }]
          };
          try {
            const lastDir = await idbGet('screenflow_last_dir_handle');
            if (lastDir && (await lastDir.queryPermission({ mode: 'readwrite' })) !== 'denied') opts.startIn = lastDir;
          } catch (e) {}
          handle = await window.showSaveFilePicker(opts);
          activeFileHandle = handle;
          try { await idbSet('screenflow_last_dir_handle', handle); } catch (e) {}
        }
        const writable = await handle.createWritable();
        await writable.write(fountainOutput);
        await writable.close();
        showToast('Saved to disk');
        showSaveFlash('Saved to Disk!');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('File System Access API failed', err);
      }
    }
    const blob = new Blob([fountainOutput], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${title}.fountain`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    showToast('Exported .fountain file');
    showSaveFlash('Exported Fountain Script!');
  }

  async function importFountainText() {
    if (window.showOpenFilePicker) {
      try {
        const opts = {
          types: [{ description: 'Fountain Screenplay', accept: { 'text/plain': ['.fountain', '.txt', '.spmd'] } }],
          excludeAcceptAllOption: true, multiple: false
        };
        try {
          const lastDir = await idbGet('screenflow_last_open_dir_handle');
          if (lastDir && (await lastDir.queryPermission({ mode: 'read' })) !== 'denied') opts.startIn = lastDir;
        } catch (e) {}
        const [handle] = await window.showOpenFilePicker(opts);
        activeFileHandle = handle;
        const file = await handle.getFile();
        parseAndLoadFountain(file);
        try { await idbSet('screenflow_last_open_dir_handle', handle); } catch (e) {}
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('File System Access Open failed', err);
      }
    }
    if (importFountainFile) importFountainFile.click();
  }

  function handleFallbackFileImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    activeFileHandle = null;
    parseAndLoadFountain(file);
    e.target.value = '';
  }

  function parseAndLoadFountain(file) {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = String(evt.target.result || '');
      const lines = text.split(/\r?\n/);
      // Header block: Key: value lines (with indented continuations) until a blank line
      const meta = {};
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') { i++; break; }
        const m = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.*)$/);
        if (!m) break;
        const key = m[1].trim().toLowerCase();
        if (!['title','author','authors','contact','source','draft','date','copyright','credit','notes'].includes(key)) break;
        let value = m[2].trim();
        i++;
        while (i < lines.length && /^\s+\S/.test(lines[i])) { value += (value ? '\n' : '') + lines[i].trim(); i++; }
        meta[key] = value;
      }
      const bodyLines = lines.slice(i);
      // Fountain title-page keys can also appear as a leading block only;
      // if no header was found, fall back to scanning the first lines.
      const blocks = parseLinesToBlocks(bodyLines.length ? bodyLines : lines);
      if (!blocks.length) { showToast('No screenplay content found in that file.'); return; }

      flushAutoSave();
      currentScriptId = 'script_' + Date.now();
      store.set('screenflow_current_id', currentScriptId);
      activeFileHandle = null;

      const fallbackTitle = file.name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      scriptTitleInput.value = meta.title || fallbackTitle;
      if (meta.author || meta.authors) store.set(`screenflow_meta_author_${currentScriptId}`, meta.author || meta.authors);
      if (meta.contact) store.set(`screenflow_meta_contact_${currentScriptId}`, meta.contact);
      if (meta.title) store.set(`screenflow_meta_title_${currentScriptId}`, meta.title);

      // Build DOM nodes directly: file text can never inject markup.
      const frag = document.createDocumentFragment();
      blocks.forEach(b => frag.appendChild(makeBlock(b.type, b.text)));
      editor.replaceChildren(frag);
      lastSceneSignature = lastCastSignature = lastLocationSignature = null;
      updateScriptAnalysis(true);
      saveScriptToLocalStorage();
      renderRecentsUI();
      editor.focus();
      const first = editor.querySelector('.element');
      if (first) setCaret(first, 0);
      showToast('Script loaded');
    };
    reader.onerror = () => showToast('Could not read that file.');
    reader.readAsText(file);
  }

  function setupDragAndDrop() {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      if (/\.(fountain|txt|spmd)$/i.test(file.name)) parseAndLoadFountain(file);
      else showToast('Drop a .fountain or .txt screenplay file.');
    });
  }

  // ================= Recents / script management =================
  function updateRecentsList(id, title) {
    const recentsRaw = store.getJSON('screenflow_recents', []);
    const recents = (Array.isArray(recentsRaw) ? recentsRaw : []).filter(item => item.id !== id);
    recents.unshift({ id, title, lastModified: Date.now() });
    store.set('screenflow_recents', JSON.stringify(recents.slice(0, 8)));
    renderRecentsUI();
  }
  function renderRecentsUI() {
    const list = $('recent-scripts-list');
    if (!list) return;
    const recents = store.getJSON('screenflow_recents', []);
    const safe = Array.isArray(recents) ? recents : [];
    const sig = safe.map(r => `${r.id}:${r.title}`).join('|') + '#' + currentScriptId;
    if (sig === lastRecentsSignature) return; // autosave no longer re-renders the menu every second
    lastRecentsSignature = sig;
    list.replaceChildren();
    if (!safe.length) {
      const li = document.createElement('li');
      li.className = 'empty-msg';
      li.textContent = 'No recent scripts';
      list.appendChild(li);
      return;
    }
    safe.forEach(item => {
      const li = document.createElement('li');
      li.className = 'recent-script-item';
      if (item.id === currentScriptId) {
        li.style.borderColor = 'var(--accent-color)';
        li.style.backgroundColor = 'var(--accent-light)';
      }
      const titleSpan = document.createElement('span');
      titleSpan.className = 'recent-title';
      titleSpan.textContent = item.title || 'Untitled Screenplay';
      titleSpan.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); loadRecentScript(item.id); });
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-recent-btn';
      deleteBtn.title = 'Delete this script';
      deleteBtn.setAttribute('aria-label', 'Delete this script');
      deleteBtn.innerHTML = '<i data-lucide="trash-2" style="width:12px;height:12px;"></i>';
      deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteRecentScript(item.id); });
      li.appendChild(titleSpan);
      li.appendChild(deleteBtn);
      list.appendChild(li);
    });
    refreshIcons();
  }

  function loadRecentScript(id) {
    flushAutoSave();
    currentScriptId = id;
    store.set('screenflow_current_id', currentScriptId);
    activeFileHandle = null; // v1 kept the old handle: the next autosave overwrote the previous file
    formatUndoStack = []; formatRedoStack = []; lastActionWasFormatChange = false;
    scriptTitleInput.value = store.get('screenflow_title_' + id, 'Untitled Screenplay');
    const savedScript = store.get('screenflow_script_' + id);
    editor.replaceChildren();
    if (savedScript && savedScript.trim() !== '') {
      editor.innerHTML = savedScript;
      editor.querySelectorAll('.element').forEach(el => { el.style.marginTop = ''; delete el.dataset.pageBreak; });
      editor.querySelectorAll('.page-number-indicator').forEach(el => el.remove());
      normalizeEditorStructure();
    } else {
      editor.appendChild(makeBlock('scene-heading', 'INT. NEW SCENE - DAY'));
      editor.appendChild(makeBlock('action'));
    }
    lastSceneSignature = lastCastSignature = lastLocationSignature = null;
    updateScriptAnalysis(true);
    highlightActiveLine();
    lastRecentsSignature = null;
    renderRecentsUI();
    showToast('Script loaded');
  }

  function deleteRecentScript(id) {
    if (!confirm('Are you sure you want to delete this screenplay draft? This cannot be undone.')) return;
    store.remove('screenflow_title_' + id);
    store.remove('screenflow_script_' + id);
    store.remove(`screenflow_meta_title_${id}`);
    store.remove(`screenflow_meta_author_${id}`);
    store.remove(`screenflow_meta_contact_${id}`);
    const recents = (store.getJSON('screenflow_recents', []) || []).filter(item => item.id !== id);
    store.set('screenflow_recents', JSON.stringify(recents));
    lastRecentsSignature = null;
    if (id === currentScriptId) {
      createNewScript();
    } else {
      renderRecentsUI();
    }
  }

  function createNewScript() {
    flushAutoSave();
    activeFileHandle = null;
    formatUndoStack = []; formatRedoStack = []; lastActionWasFormatChange = false;
    currentScriptId = 'script_' + Date.now();
    store.set('screenflow_current_id', currentScriptId);
    scriptTitleInput.value = 'Untitled Screenplay';
    editor.replaceChildren(
      makeBlock('scene-heading', 'INT. STUDY - DAY'),
      makeBlock('action')
    );
    lastSceneSignature = lastCastSignature = lastLocationSignature = null;
    saveScriptToLocalStorage();
    updateScriptAnalysis(true);
    highlightActiveLine();
    editor.focus();
    const first = editor.querySelector('.element');
    if (first) setCaret(first, first.textContent.length);
    showToast('New draft created');
  }

  // ================= Layout / theme =================
  function collapseSidebar(persist) {
    sidebar.classList.add('collapsed');
    document.body.classList.add('sidebar-is-collapsed');
    if (persist) store.set('screenflow_sidebar_collapsed', 'true');
  }
  function expandSidebar() {
    sidebar.classList.remove('collapsed');
    document.body.classList.remove('sidebar-is-collapsed');
    store.set('screenflow_sidebar_collapsed', 'false');
  }
  function toggleTheme() {
    const isLight = document.documentElement.classList.contains('dark-theme');
    document.documentElement.classList.remove('dark-theme', 'light-theme');
    document.documentElement.classList.add(isLight ? 'light-theme' : 'dark-theme');
    store.set('screenflow_theme', isLight ? 'light-theme' : 'dark-theme');
    setThemeIcon(isLight);
  }

  // ================= Find & Replace =================
  let findHits = [];
  let findIndex = -1;
  function setupFindBar() {
    const input = $('find-input');
    input.addEventListener('input', () => refreshFindHits(false));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? stepFind(-1) : stepFind(1); }
      if (e.key === 'Escape') closeFindBar();
    });
    $('replace-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFindBar(); });
    $('find-next-btn').addEventListener('click', () => stepFind(1));
    $('find-prev-btn').addEventListener('click', () => stepFind(-1));
    $('find-close-btn').addEventListener('click', closeFindBar);
    $('replace-one-btn').addEventListener('click', replaceOne);
    $('replace-all-btn').addEventListener('click', replaceAll);
  }
  function openFindBar() {
    const bar = $('find-bar');
    bar.hidden = false;
    const selText = window.getSelection().toString().trim();
    const input = $('find-input');
    if (selText && selText.length < 60) input.value = selText;
    refreshFindHits(false);
    input.focus();
    input.select();
  }
  function closeFindBar() {
    $('find-bar').hidden = true;
    editor.querySelectorAll('.element.find-hit').forEach(el => el.classList.remove('find-hit'));
    findHits = []; findIndex = -1;
    editor.focus();
  }
  function refreshFindHits(jumpToFirst) {
    const q = $('find-input').value;
    editor.querySelectorAll('.element.find-hit').forEach(el => el.classList.remove('find-hit'));
    findHits = [];
    findIndex = -1;
    if (q) {
      const needle = q.toLowerCase();
      editor.querySelectorAll('.element').forEach(p => {
        if (p.textContent.toLowerCase().includes(needle)) findHits.push(p);
      });
    }
    $('find-count').textContent = q ? (findHits.length ? `0 / ${findHits.length}` : 'No matches') : '';
    if (jumpToFirst && findHits.length) stepFind(1);
  }
  function stepFind(dir) {
    if (!findHits.length) { refreshFindHits(false); if (!findHits.length) return; }
    findIndex = (findIndex + dir + findHits.length) % findHits.length;
    editor.querySelectorAll('.element.find-hit').forEach(el => el.classList.remove('find-hit'));
    const block = findHits[findIndex];
    block.classList.add('find-hit');
    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Select the matched text inside the block
    const q = $('find-input').value;
    const idx = block.textContent.toLowerCase().indexOf(q.toLowerCase());
    if (idx >= 0 && block.firstChild && block.firstChild.nodeType === Node.TEXT_NODE) {
      try { editor.focus(); setCaret(block, idx); window.getSelection().extend(block.firstChild, Math.min(idx + q.length, block.textContent.length)); } catch (e) {}
    }
    $('find-count').textContent = `${findIndex + 1} / ${findHits.length}`;
  }
  function replaceOne() {
    const q = $('find-input').value;
    if (!q) return;
    const current = findIndex >= 0 ? findHits[findIndex] : getCurrentBlock();
    if (current && current.textContent.toLowerCase().includes(q.toLowerCase())) {
      const idx = current.textContent.toLowerCase().indexOf(q.toLowerCase());
      const r = $('replace-input').value;
      current.textContent = current.textContent.substring(0, idx) + r + current.textContent.substring(idx + q.length);
      editor.focus(); setCaret(current, idx + r.length);
      scheduleAnalysis(); triggerAutoSave();
      refreshFindHits(false);
      if (findHits.length) stepFind(1);
      return;
    }
    stepFind(1);
  }
  function replaceAll() {
    const q = $('find-input').value;
    if (!q) return;
    const r = $('replace-input').value;
    const re = new RegExp(escapeRegExp(q), 'gi');
    let count = 0;
    editor.querySelectorAll('.element').forEach(p => {
      const before = p.textContent;
      const after = before.replace(re, () => { count++; return r; });
      if (after !== before) p.textContent = after;
    });
    scheduleAnalysis(); triggerAutoSave();
    refreshFindHits(false);
    showToast(count ? `Replaced ${count} match${count === 1 ? '' : 'es'}` : 'No matches to replace');
  }

  // ================= PDF export =================
  function saveAsPDF() {
    const jsPDFClass = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!jsPDFClass) { showToast('PDF library is still loading, try again in a moment.'); return; }
    const doc = new jsPDFClass({ orientation: 'portrait', unit: 'pt', format: 'letter' });
    const title = scriptTitleInput.value || 'Untitled Screenplay';
    const metaTitle = store.get(`screenflow_meta_title_${currentScriptId}`, '') || title;
    const metaAuthor = store.get(`screenflow_meta_author_${currentScriptId}`, '');
    const metaContact = store.get(`screenflow_meta_contact_${currentScriptId}`, '');
    try { doc.setProperties({ title: metaTitle, author: metaAuthor }); } catch (e) {}

    // Title page ONLY when the writer actually filled in title-page info.
    // v1 fell back metaTitle -> title (always non-empty), so every PDF got
    // an unwanted title page.
    const hasTitlePage = metaAuthor.trim() !== '' || metaContact.trim() !== '';
    if (hasTitlePage) {
      doc.setFont('Courier', 'bold'); doc.setFontSize(18);
      let titleY = 280;
      doc.splitTextToSize(metaTitle.toUpperCase(), 360).forEach(line => { doc.text(line, 306, titleY, { align: 'center' }); titleY += 18; });
      doc.setFont('Courier', 'normal'); doc.setFontSize(12);
      let midY = 360;
      doc.text('by', 306, midY, { align: 'center' }); midY += 24;
      doc.splitTextToSize(metaAuthor.trim() || 'Anonymous', 300).forEach(line => { doc.text(line, 306, midY, { align: 'center' }); midY += 14; });
      if (metaContact.trim() !== '') {
        doc.setFontSize(10);
        const contactLines = doc.splitTextToSize(metaContact, 300);
        let contactY = 660 - contactLines.length * 12;
        contactLines.forEach(line => { doc.text(line, 108, contactY); contactY += 12; });
      }
      doc.addPage();
    }

    doc.setFont('Courier', 'normal'); doc.setFontSize(12);
    let y = 72;
    const maxY = 720, lineHeight = 14;
    editor.querySelectorAll('.element').forEach(p => {
      const text = p.textContent.trim();
      if (text === '') return;
      const type = getElementType(p);
      let leftMargin = 108, width = 432, align = 'left';
      if (type === 'scene-heading') { doc.setFont('Courier', 'bold'); if (y > 72) y += 24; }
      else if (type === 'action') { doc.setFont('Courier', 'normal'); if (y > 72) y += 12; }
      else if (type === 'character') { leftMargin = 266.4; width = 252; doc.setFont('Courier', 'normal'); if (y > 72) y += 12; }
      else if (type === 'parenthetical') { leftMargin = 223.2; width = 144; doc.setFont('Courier', 'normal'); }
      else if (type === 'dialogue') { leftMargin = 180; width = 252; doc.setFont('Courier', 'normal'); }
      else if (type === 'transition') { align = 'right'; doc.setFont('Courier', 'normal'); if (y > 72) y += 12; }

      let contentText = text;
      if (type === 'character' || type === 'scene-heading' || type === 'transition') contentText = contentText.toUpperCase();
      if (type === 'parenthetical') {
        if (!contentText.startsWith('(')) contentText = '(' + contentText;
        if (!contentText.endsWith(')')) contentText += ')';
      }
      const lines = doc.splitTextToSize(contentText, width);
      let extra = 0;
      if (type === 'character') extra = lineHeight * 2;
      if (type === 'scene-heading') extra = lineHeight * 3;
      if (y + lines.length * lineHeight + extra > maxY) { doc.addPage(); y = 72; }
      lines.forEach(lineText => {
        if (y + lineHeight > maxY) { doc.addPage(); y = 72; }
        if (align === 'right') doc.text(lineText, 540, y + 10, { align: 'right' });
        else doc.text(lineText, leftMargin, y + 10);
        y += lineHeight;
      });
      if (type === 'scene-heading') doc.setFont('Courier', 'normal');
    });

    // Page numbers: script page 1 is unnumbered, numbering starts at "2."
    const totalPages = doc.internal.getNumberOfPages();
    const firstScriptPage = hasTitlePage ? 2 : 1;
    for (let docPage = firstScriptPage + 1; docPage <= totalPages; docPage++) {
      doc.setPage(docPage);
      doc.setFont('Courier', 'normal'); doc.setFontSize(12);
      doc.text(`${docPage - firstScriptPage + 1}.`, 540, 36, { align: 'right' });
    }
    doc.save(`${title}.pdf`);
    showToast('PDF saved');
  }
});

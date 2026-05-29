/* ==========================================================================
   ScreenFlow Editor Logic & State Management
   ========================================================================== */

// --- IndexedDB Helpers (for storing FileSystemHandles, which can't go in localStorage) ---
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


document.addEventListener('DOMContentLoaded', () => {
  // --- DOM Elements ---
  const editor = document.getElementById('screenplay-editor');
  const sidebar = document.getElementById('sidebar');
  const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
  const expandSidebarBtn = document.getElementById('expand-sidebar-btn');
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const helpToggleBtn = document.getElementById('help-toggle-btn');
  const helpModal = document.getElementById('help-modal');
  const closeModalBtn = document.getElementById('close-modal-btn');
  const closeModalFooterBtn = document.getElementById('close-modal-footer-btn');
  const scriptTitleInput = document.getElementById('script-title-input');
  const zoomSlider = document.getElementById('zoom-slider');
  const zoomSliderLabel = document.getElementById('zoom-slider-label');
  
  // Format Picker Dropdown
  const formatPickerBtn = document.getElementById('format-picker-btn');
  const formatPickerDropdown = document.getElementById('format-picker-dropdown');
  const formatPickerLabel = document.getElementById('format-picker-label');
  const formatOptions = document.querySelectorAll('.format-option');
  const btnSavePdfHeader = document.getElementById('btn-export-pdf');
  
  // Script Actions
  const btnExportFountain = document.getElementById('btn-export-fountain');
  const lblImportFountain = document.getElementById('lbl-import-fountain');
  const importFountainFile = document.getElementById('import-fountain-file');
  const btnNewScript = document.getElementById('btn-new-script');
  
  // Menu & Settings Toggles
  const menuBtn = document.getElementById('menu-btn');
  const menuDropdown = document.getElementById('menu-dropdown');
  const toggleHighlights = document.getElementById('toggle-highlights');
  const toggleSpellcheck = document.getElementById('toggle-spellcheck');
  const toggleRegistry = document.getElementById('toggle-registry');
  const toggleStats = document.getElementById('toggle-stats');
  const footerStatPages = document.getElementById('footer-stat-pages');
  const footerStatWords = document.getElementById('footer-stat-words');
  
  // Outlines, Stats & Lists
  const sceneList = document.getElementById('scene-list');
  const sceneCountBadge = document.getElementById('scene-count-badge');
  const statPages = document.getElementById('stat-pages');
  const statWords = document.getElementById('stat-words');
  
  // Cast & Locations Registers
  const registryTabButtons = document.querySelectorAll('.registry-section .tab-btn');
  const registryPanels = document.querySelectorAll('.registry-panel');
  const charactersRegistry = document.getElementById('characters-registry');
  const locationsRegistry = document.getElementById('locations-registry');
  
  // Autocomplete & Footer Hints
  const autocompleteBox = document.getElementById('autocomplete-box');
  const shortcutHint = document.getElementById('shortcut-hint');
  const saveStatus = document.getElementById('save-status');

  // --- State Variables ---
  let activeBlock = null;
  let castList = new Set();
  let locationList = new Set();
  let autoSaveTimeout = null;
  let currentScriptId = localStorage.getItem('screenflow_current_id') || 'script_' + Date.now();
  let activeFileHandle = null;
  
  // Autocomplete state
  let suggestionIndex = -1;
  let currentSuggestions = [];

  // Format undo stack — tracks element-type changes separately from browser text undo
  let formatUndoStack = [];
  let formatRedoStack = [];
  let lastTextEditTime = 0;

  // --- Page Pagination Constants ---
  // Each visual page = 1056px of white paper + 48px transparent gap = 1104px total
  const FULL_PAGE = 1104;
  const PAGE_HEIGHT = 1056;
  const PAGE_MARGIN_TOP = 96;   // 1 inch
  const PAGE_MARGIN_BOTTOM = 96; // 1 inch

  // --- Initialize App ---
  init();

  function init() {
    // Load Script from LocalStorage or default to starter template
    loadScriptFromLocalStorage();
    // Load Settings Preferences
    const savedTheme = localStorage.getItem('screenflow_theme') || 'dark-theme';
    document.documentElement.classList.remove('dark-theme', 'light-theme');
    document.documentElement.classList.add(savedTheme);
    const themeIcon = document.getElementById('theme-toggle-icon');
    if (themeIcon) {
      themeIcon.setAttribute('data-lucide', savedTheme === 'dark-theme' ? 'sun' : 'moon');
    }
    if (themeToggleBtn) {
      themeToggleBtn.setAttribute('title', savedTheme === 'dark-theme' ? 'Switch to Crisp Paper Theme' : 'Switch to Dark Slate Theme');
    }

    const savedHighlights = localStorage.getItem('screenflow_setting_highlights');
    if (savedHighlights !== null && toggleHighlights) {
      toggleHighlights.checked = savedHighlights === 'true';
      if (!toggleHighlights.checked) editor.classList.add('disable-highlights');
    }

    const savedSpellcheck = localStorage.getItem('screenflow_setting_spellcheck');
    if (savedSpellcheck !== null && toggleSpellcheck) {
      toggleSpellcheck.checked = savedSpellcheck === 'true';
      editor.setAttribute('spellcheck', savedSpellcheck === 'true' ? "true" : "false");
    }

    const savedRegistry = localStorage.getItem('screenflow_setting_registry');
    if (savedRegistry !== null && toggleRegistry) {
      toggleRegistry.checked = savedRegistry === 'true';
      const registrySection = document.querySelector('.registry-section');
      if (registrySection) registrySection.style.display = savedRegistry === 'true' ? 'block' : 'none';
    }

    const savedStats = localStorage.getItem('screenflow_setting_stats');
    if (savedStats !== null && toggleStats) {
      toggleStats.checked = savedStats === 'true';
      const hidden = savedStats !== 'true';
      if (footerStatPages) footerStatPages.classList.toggle('hidden', hidden);
      if (footerStatWords) footerStatWords.classList.toggle('hidden', hidden);
      // Also hide the dividers adjacent to them
      setStatDividersVisible(savedStats === 'true');
    }

    
    // Load document zoom factor from LocalStorage
    const savedZoom = localStorage.getItem('screenflow_zoom') || '1.0';
    if (zoomSlider) {
      zoomSlider.value = savedZoom;
    }
    if (zoomSliderLabel) {
      zoomSliderLabel.textContent = `${Math.round(parseFloat(savedZoom) * 100)}%`;
    }
    const paperContainer = document.querySelector('.paper-container');
    if (paperContainer) paperContainer.style.setProperty('--zoom-factor', savedZoom);
    
    // Restore sidebar collapsed state
    const sidebarCollapsed = localStorage.getItem('screenflow_sidebar_collapsed') === 'true';
    if (sidebarCollapsed) {
      collapseSidebar();
    }

    // Register Core Event Listeners
    setupEventListeners();
    
    // Remove early initial-state classes after DOM layouts have settled
    document.documentElement.classList.remove('sidebar-is-collapsed-init', 'disable-highlights-init', 'hide-stats-init');
    
    // Scan and build stats immediately
    updateScriptAnalysis();
    
    // Highlight initial active line
    highlightActiveLine();

    // Initialize Recent Scripts list UI
    renderRecentsUI();

    // Initialize drag and drop
    setupDragAndDrop();
  }

  // --- Event Listeners Setup ---
  function setupEventListeners() {
    // Editor Input & Cursor Mechanics
    editor.addEventListener('keydown', handleEditorKeyDown);
    editor.addEventListener('keyup', handleEditorKeyUp);
    editor.addEventListener('click', handleEditorClick);
    editor.addEventListener('input', handleEditorInput);
    editor.addEventListener('blur', handleEditorBlur);
    editor.addEventListener('paste', handleEditorPaste);

    // Format Picker: open/close dropdown via mousedown to keep editor focus
    formatPickerBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const isOpen = formatPickerDropdown.classList.contains('show');
      if (isOpen) {
        formatPickerDropdown.classList.remove('show');
        formatPickerBtn.classList.remove('open');
      } else {
        formatPickerDropdown.classList.add('show');
        formatPickerBtn.classList.add('open');
      }
    });

    // Format Option selection
    formatOptions.forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Retain editor focus
        const type = btn.getAttribute('data-type');
        normalizeEditorStructure();
        const selection = window.getSelection();
        let targetBlock = activeBlock;
        if (selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          targetBlock = getParagraphAncestor(range.startContainer) || activeBlock;
        }
        if (!targetBlock) targetBlock = editor.querySelector('.active-line');
        if (targetBlock) {
          changeBlockType(targetBlock, type);
          editor.focus();
        }
        formatPickerDropdown.classList.remove('show');
        formatPickerBtn.classList.remove('open');
      });
    });

    // Close format picker when clicking elsewhere
    document.addEventListener('mousedown', (e) => {
      if (!formatPickerBtn.contains(e.target) && !formatPickerDropdown.contains(e.target)) {
        formatPickerDropdown.classList.remove('show');
        formatPickerBtn.classList.remove('open');
      }
    });

    // Theme Toggle
    themeToggleBtn.addEventListener('click', toggleTheme);

    // Sidebar Toggles
    toggleSidebarBtn.addEventListener('click', collapseSidebar);
    expandSidebarBtn.addEventListener('click', expandSidebar);

    // Dynamic left-edge mouse tracking for uncollapse button
    document.addEventListener('mousemove', (e) => {
      const isCollapsed = document.documentElement.classList.contains('sidebar-is-collapsed-init') || 
                          document.body.classList.contains('sidebar-is-collapsed');
      if (!isCollapsed) {
        expandSidebarBtn.classList.remove('visible');
        return;
      }
      
      // Calculate viewport bottom boundaries to exclude the bottom bar (40px)
      const isOverBottomBar = e.clientY >= (window.innerHeight - 40);
      
      // If cursor is within 50px of the left edge of the viewport and not over the bottom bar
      if (e.clientX <= 50 && !isOverBottomBar) {
        expandSidebarBtn.style.top = `${e.clientY}px`;
        expandSidebarBtn.classList.add('visible');
      } else {
        // Keep it visible if the mouse is directly hovering over the button itself
        const rect = expandSidebarBtn.getBoundingClientRect();
        const hoveringBtn = (
          e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom
        );
        if (!hoveringBtn) {
          expandSidebarBtn.classList.remove('visible');
        }
      }
    });

    // Help Modal
    helpToggleBtn.addEventListener('click', openHelpModal);
    closeModalBtn.addEventListener('click', closeHelpModal);
    closeModalFooterBtn.addEventListener('click', closeHelpModal);
    helpModal.addEventListener('click', (e) => {
      if (e.target === helpModal) closeHelpModal();
    });

    // Metadata Modal Selectors
    const metadataModal = document.getElementById('metadata-modal');
    const metadataModalBtn = document.getElementById('metadata-modal-btn');
    const closeMetadataModalBtn = document.getElementById('close-metadata-modal-btn');
    const saveMetadataModalBtn = document.getElementById('save-metadata-modal-btn');

    const metadataTitleInput = document.getElementById('metadata-title-input');
    const metadataAuthorInput = document.getElementById('metadata-author-input');
    const metadataContactInput = document.getElementById('metadata-contact-input');

    // Load Title Page Metadata
    const loadMetadata = () => {
      const savedTitle = localStorage.getItem(`screenflow_meta_title_${currentScriptId}`) || '';
      const savedAuthor = localStorage.getItem(`screenflow_meta_author_${currentScriptId}`) || '';
      const savedContact = localStorage.getItem(`screenflow_meta_contact_${currentScriptId}`) || '';

      metadataTitleInput.value = savedTitle || scriptTitleInput.value;
      metadataAuthorInput.value = savedAuthor;
      metadataContactInput.value = savedContact;
    };

    metadataModalBtn.addEventListener('click', () => {
      loadMetadata();
      metadataModal.classList.add('active');
    });

    const closeMetadataModal = () => {
      metadataModal.classList.remove('active');
    };

    closeMetadataModalBtn.addEventListener('click', closeMetadataModal);
    metadataModal.addEventListener('click', (e) => {
      if (e.target === metadataModal) closeMetadataModal();
    });

    saveMetadataModalBtn.addEventListener('click', () => {
      localStorage.setItem(`screenflow_meta_title_${currentScriptId}`, metadataTitleInput.value);
      localStorage.setItem(`screenflow_meta_author_${currentScriptId}`, metadataAuthorInput.value);
      localStorage.setItem(`screenflow_meta_contact_${currentScriptId}`, metadataContactInput.value);
      
      if (metadataTitleInput.value.trim() !== '') {
        scriptTitleInput.value = metadataTitleInput.value;
        triggerAutoSave();
      }
      closeMetadataModal();
      showSaveFlash("Title Page Configured");
    });

    // Actions
    if (btnSavePdfHeader) btnSavePdfHeader.addEventListener('click', saveAsPDF);
    btnExportFountain.addEventListener('click', exportFountainText);
    if (lblImportFountain) lblImportFountain.addEventListener('click', importFountainText);
    if (importFountainFile) importFountainFile.addEventListener('change', handleFallbackFileImport);
    if (btnNewScript) {
      btnNewScript.addEventListener('click', () => {
        createNewScript();
        loadMetadata();
      });
    }

    // Dropdown Menu Toggling
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menuDropdown.classList.toggle('show');
    });

    // Close Menu on clicking outside
    document.addEventListener('click', (e) => {
      if (!menuDropdown.contains(e.target) && e.target !== menuBtn) {
        menuDropdown.classList.remove('show');
      }
    });

    // Settings Toggle: Scene Highlights
    toggleHighlights.addEventListener('change', () => {
      if (toggleHighlights.checked) {
        editor.classList.remove('disable-highlights');
      } else {
        editor.classList.add('disable-highlights');
      }
      localStorage.setItem('screenflow_setting_highlights', toggleHighlights.checked);
    });

    // Settings Toggle: Spellcheck
    toggleSpellcheck.addEventListener('change', () => {
      editor.setAttribute('spellcheck', toggleSpellcheck.checked ? "true" : "false");
      localStorage.setItem('screenflow_setting_spellcheck', toggleSpellcheck.checked);
    });

    // Settings Toggle: Registry (Characters/Locations)
    toggleRegistry.addEventListener('change', () => {
      const registrySection = document.querySelector('.registry-section');
      if (registrySection) {
        registrySection.style.display = toggleRegistry.checked ? 'block' : 'none';
      }
      localStorage.setItem('screenflow_setting_registry', toggleRegistry.checked);
    });

    // Settings Toggle: Stats bar
    if (toggleStats) {
      toggleStats.addEventListener('change', () => {
        const show = toggleStats.checked;
        if (footerStatPages) footerStatPages.classList.toggle('hidden', !show);
        if (footerStatWords) footerStatWords.classList.toggle('hidden', !show);
        setStatDividersVisible(show);
        localStorage.setItem('screenflow_setting_stats', show);
      });
    }
    
    // Tab Navigation for Cast/Locations registry
    registryTabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        registryTabButtons.forEach(b => b.classList.remove('active'));
        registryPanels.forEach(p => p.classList.remove('active'));
        
        btn.classList.add('active');
        const tabName = btn.getAttribute('data-tab');
        document.getElementById(`${tabName}-panel`).classList.add('active');
      });
    });

    // Rename script name auto-save
    scriptTitleInput.addEventListener('input', () => {
      triggerAutoSave();
    });

    // Exit title input editing box on pressing Enter
    scriptTitleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        scriptTitleInput.blur();
      }
    });

    // Document Zoom Controller range slider input handling with notch snapping
    if (zoomSlider) {
      const snapPoints = [1.0, 1.5, 2.0];
      const snapThreshold = 0.08;

      const updateZoom = (val, forceSet = false) => {
        let finalVal = parseFloat(val);
        // Snapping logic: check if value is close to one of the snap points
        for (const snapVal of snapPoints) {
          if (Math.abs(finalVal - snapVal) <= snapThreshold) {
            finalVal = snapVal;
            break;
          }
        }

        // Apply snapping visual indicator
        if (forceSet || Math.abs(parseFloat(val) - finalVal) > 0.01) {
          zoomSlider.value = finalVal;
        }

        if (zoomSliderLabel) {
          zoomSliderLabel.textContent = `${Math.round(finalVal * 100)}%`;
        }

        const paperContainer = document.querySelector('.paper-container');
        if (paperContainer) paperContainer.style.setProperty('--zoom-factor', finalVal.toString());
        localStorage.setItem('screenflow_zoom', finalVal.toString());
      };

      zoomSlider.addEventListener('input', (e) => {
        updateZoom(e.target.value, false);
      });

      zoomSlider.addEventListener('change', (e) => {
        updateZoom(e.target.value, true);
      });
    }

    // Make sidebar panels vertically resizable
    const sceneListWrapper = document.querySelector('.scene-list-wrapper');
    if (sceneListWrapper) makeResizable(sceneListWrapper);
    registryPanels.forEach(panel => makeResizable(panel));
  }

  // --- Sidebar Width Resizer ---
  const sidebarWidthResizer = document.getElementById('sidebar-width-resizer');
  if (sidebarWidthResizer) {
    let isResizingSidebar = false;
    let startX, startWidth;

    const savedSidebarWidth = localStorage.getItem('screenflow_sidebar_width');
    if (savedSidebarWidth) {
      document.documentElement.style.setProperty('--sidebar-width', savedSidebarWidth);
    }

    sidebarWidthResizer.addEventListener('mousedown', (e) => {
      // Don't intercept clicks on the collapse button
      if (e.target.closest('#toggle-sidebar-btn')) return;
      isResizingSidebar = true;
      startX = e.clientX;
      startWidth = parseInt(document.defaultView.getComputedStyle(sidebar).width, 10);
      
      sidebar.style.transition = 'none';
      document.body.style.cursor = 'ew-resize';
      
      document.addEventListener('mousemove', handleSidebarMouseMove);
      document.addEventListener('mouseup', handleSidebarMouseUp);
      e.preventDefault();
    });

    function handleSidebarMouseMove(e) {
      if (!isResizingSidebar) return;
      const newWidth = Math.max(150, Math.min(600, startWidth + (e.clientX - startX)));
      document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
    }

    function handleSidebarMouseUp() {
      isResizingSidebar = false;
      document.body.style.cursor = '';
      sidebar.style.transition = ''; // restore CSS transition
      document.removeEventListener('mousemove', handleSidebarMouseMove);
      document.removeEventListener('mouseup', handleSidebarMouseUp);
      
      localStorage.setItem('screenflow_sidebar_width', document.documentElement.style.getPropertyValue('--sidebar-width'));
    }
  }

  // --- Custom Resizer logic ---
  function makeResizable(element) {
    let isResizing = false;
    let startY, startHeight;
    const RESIZE_ZONE = 8; // detection zone in pixels

    // Restore saved height if available
    let storageKey = element.id ? `screenflow_resizer_${element.id}` : 
                     (element.classList.contains('scene-list-wrapper') ? 'screenflow_resizer_scene-list' : null);
    
    if (storageKey) {
      const savedHeight = localStorage.getItem(storageKey);
      if (savedHeight) {
        element.style.height = savedHeight;
      }
    }

    element.addEventListener('mousemove', (e) => {
      if (isResizing) return;
      const rect = element.getBoundingClientRect();
      if (e.clientY >= rect.bottom - RESIZE_ZONE && e.clientY <= rect.bottom) {
        element.style.cursor = 'ns-resize';
      } else {
        element.style.cursor = '';
      }
    });
    
    element.addEventListener('mouseleave', () => {
      if (!isResizing) element.style.cursor = '';
    });

    element.addEventListener('mousedown', (e) => {
      const rect = element.getBoundingClientRect();
      if (e.clientY >= rect.bottom - RESIZE_ZONE && e.clientY <= rect.bottom) {
        isResizing = true;
        startY = e.clientY;
        startHeight = parseInt(document.defaultView.getComputedStyle(element).height, 10);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = 'ns-resize';
        e.preventDefault();
      }
    });

    function handleMouseMove(e) {
      if (!isResizing) return;
      const newHeight = startHeight + (e.clientY - startY);
      element.style.height = `${Math.max(50, newHeight)}px`;
    }

    function handleMouseUp() {
      isResizing = false;
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      
      if (storageKey) {
        localStorage.setItem(storageKey, element.style.height);
      }
    }
  }

  // --- Editor Formatting Engine ---
  
  function handleEditorKeyDown(e) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    
    const range = selection.getRangeAt(0);
    const block = getParagraphAncestor(range.startContainer);
    if (!block) return;
    
    activeBlock = block;

    // 1. Handle Autocomplete popup interactions (if open)
    if (autocompleteBox.style.display === 'block') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateSuggestions(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateSuggestions(-1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptSuggestion();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAutocomplete();
        return;
      }
    }

    // 2. Handle standard Enter behavior override (Smart Flow Transitions)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSmartEnter(block, range, selection);
      return;
    }

    // 3. Handle Tab behavior override
    if (e.key === 'Tab') {
      e.preventDefault();
      handleSmartTab(block);
      return;
    }

    // 4. Handle Backspace on empty formatting block
    if (e.key === 'Backspace') {
      // If block text content is empty, revert its format to 'action' instead of deleting the paragraph
      if (block.textContent.trim() === '') {
        const type = getElementType(block);
        if (type !== 'action') {
          e.preventDefault();
          changeBlockType(block, 'action');
          return;
        }
      }
    }

    // 4.5 Ctrl+Y or Ctrl+Shift+Z: redo format type changes
    if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.key.toLowerCase() === 'z' && e.shiftKey)) {
      if (formatRedoStack.length > 0) {
        const top = formatRedoStack[formatRedoStack.length - 1];
        if (editor.contains(top.block)) {
          e.preventDefault();
          formatRedoStack.pop();
          changeBlockType(top.block, top.newType, false, true); // isRedo = true
          return;
        } else {
          formatRedoStack.pop(); // stale ref
        }
      }
    }
    // 4.6 Ctrl+Z: undo format type changes before browser text undo
    else if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (formatUndoStack.length > 0) {
        const top = formatUndoStack[formatUndoStack.length - 1];
        // Only intercept if the format change happened AFTER the last text edit
        if (editor.contains(top.block) && top.timestamp >= lastTextEditTime) {
          e.preventDefault();
          formatUndoStack.pop();
          changeBlockType(top.block, top.oldType, true, false); // isUndo = true
          return;
        } else if (!editor.contains(top.block)) {
          formatUndoStack.pop(); // stale ref, clean up
        }
      }
      // Fall through to browser's native text undo
    }

    // 5. Hotkeys: Ctrl + 1-6 Manual Styles overrides
    if (e.ctrlKey && !isNaN(e.key)) {
      const num = parseInt(e.key);
      const types = {
        1: 'scene-heading',
        2: 'action',
        3: 'character',
        4: 'parenthetical',
        5: 'dialogue',
        6: 'transition'
      };
      
      if (types[num]) {
        e.preventDefault();
        changeBlockType(block, types[num]);
      }
    }
  }

  function handleEditorKeyUp(e) {
    // Basic navigation or key release functions
    highlightActiveLine();
    
    // Note: Visual uppercase for scene-heading, character, and transition
    // is handled by CSS text-transform: uppercase — no JS mutation needed.

    // Trigger autocomplete search
    handleAutocompleteSearch();
  }

  function handleEditorClick() {
    highlightActiveLine();
    closeAutocomplete();
  }

  function handleEditorInput() {
    lastTextEditTime = Date.now();
    
    // Auto-detect scene headings on type
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const block = getParagraphAncestor(selection.getRangeAt(0).startContainer);
      if (block) {
        const type = getElementType(block);
        const text = block.textContent.trim().toUpperCase();
        // If it looks like a scene heading and is currently an action, auto-convert it
        if (type === 'action' && text.match(/^(INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/)) {
          changeBlockType(block, 'scene-heading', true); // skip undo push to not interrupt typing
        }
      }
    }

    triggerAutoSave();
    updateScriptAnalysis();
  }

  function handleEditorBlur() {
    closeAutocomplete();
    normalizeEditorStructure();
    // Clear the active-line highlight when editor loses focus
    document.querySelectorAll('.paper .element').forEach(el => {
      el.classList.remove('active-line');
    });
  }

  function handleEditorPaste(e) {
    e.preventDefault();
    
    const clipboard = e.clipboardData || window.clipboardData;
    const htmlText = clipboard.getData('text/html');
    const plainText = clipboard.getData('text/plain') || clipboard.getData('text');
    
    const docFragment = document.createDocumentFragment();
    let parsedElements = [];
    
    // Helper to traverse ancestors and find if any has a specific class/style keyword (Celtx metadata capture)
    function hasParentWithKeyword(element, docBody, keyword) {
      let curr = element;
      while (curr && curr !== docBody) {
        const className = (curr.className || '').toLowerCase();
        const style = (curr.getAttribute('style') || '').toLowerCase();
        if (className.includes(keyword) || style.includes(keyword)) {
          return true;
        }
        curr = curr.parentNode;
      }
      return false;
    }

    // 1. Dual-Mode: Try parsing rich HTML first (preserves Celtx native class metadata)
    if (htmlText) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, 'text/html');
      
      // Select leaf block elements to prevent duplicate nested parsing
      const allElements = Array.from(doc.body.querySelectorAll('*'));
      const leafBlocks = allElements.filter(el => {
        const isBlock = ['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(el.nodeName);
        if (!isBlock) return false;
        if (el.textContent.trim() === '') return false;
        
        // Exclude elements that contain other block elements (ensures leaf only)
        const childBlocks = el.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6');
        return childBlocks.length === 0;
      });

      if (leafBlocks.length > 0) {
        let inDialogue = false;
        
        leafBlocks.forEach(block => {
          const text = block.textContent.trim();
          if (text === '') return;
          
          let type = '';

          // Celtx classes or standard formats checks in parent hierarchies
          if (hasParentWithKeyword(block, doc.body, 'scene') || 
              hasParentWithKeyword(block, doc.body, 'heading') || 
              hasParentWithKeyword(block, doc.body, 'slug') || 
              hasParentWithKeyword(block, doc.body, 'slugline')) {
            type = 'scene-heading';
          } else if (hasParentWithKeyword(block, doc.body, 'character') || 
                     hasParentWithKeyword(block, doc.body, 'char')) {
            type = 'character';
          } else if (hasParentWithKeyword(block, doc.body, 'parenthetical') || 
                     hasParentWithKeyword(block, doc.body, 'paren')) {
            type = 'parenthetical';
          } else if (hasParentWithKeyword(block, doc.body, 'dialogue') || 
                     hasParentWithKeyword(block, doc.body, 'dialog')) {
            type = 'dialogue';
          } else if (hasParentWithKeyword(block, doc.body, 'transition')) {
            type = 'transition';
          }
          
          // Check styles if classes don't match
          if (!type) {
            const styleAttr = (block.getAttribute('style') || '').toLowerCase();
            const marginMatch = styleAttr.match(/(?:margin|padding)-left\s*:\s*([\d\.]+)\s*(in|px|%|em|pt)?/);
            if (marginMatch) {
              const val = parseFloat(marginMatch[1]);
              const unit = marginMatch[2] || 'px';
              
              // Convert value to approx inches
              let inches = val;
              if (unit === 'px') inches = val / 96;
              else if (unit === '%') inches = (val / 100) * 8.5;
              else if (unit === 'pt') inches = val / 72;
              else if (unit === 'em') inches = val * 0.16;

              // Match standard screenplay indentation rules (margins relative to 1.5in baseline or page left)
              if (inches >= 1.8 && inches <= 2.8) {
                type = 'character';
              } else if (inches >= 1.2 && inches <= 1.7) {
                type = 'parenthetical';
              } else if (inches >= 0.6 && inches <= 1.1) {
                type = 'dialogue';
              }
            }
          }
          
          // Fallback to text parsing heuristics
          if (!type) {
            const upperText = text.toUpperCase();
            if (text.match(/^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/i)) {
              type = 'scene-heading';
              inDialogue = false;
            } else if (text.startsWith('(') && text.endsWith(')')) {
              type = 'parenthetical';
            } else if (text.match(/^[A-Z\s]+ TO:$/) || text.startsWith('>')) {
              type = 'transition';
              inDialogue = false;
            } else if (text === upperText && text.length < 35 && !text.match(/^[0-9\.\-\#]+$/)) {
              type = 'character';
              inDialogue = true;
            } else if (inDialogue) {
              type = 'dialogue';
            } else {
              type = 'action';
            }
          } else {
            // Keep dialogue state tracking accurate
            if (type === 'character') inDialogue = true;
            else if (type === 'scene-heading' || type === 'transition' || type === 'action') inDialogue = false;
          }
          
          // Clean standard parenthetical formatting (parens handled by CSS)
          let cleanText = text;
          if (type === 'parenthetical' && cleanText.startsWith('(') && cleanText.endsWith(')')) {
            cleanText = cleanText.slice(1, -1).trim();
          }
          
          parsedElements.push({ type, text: cleanText });
        });
      }
    }
    
    // 2. Fallback: Parse plain text if HTML was empty or returned no elements
    if (parsedElements.length === 0 && plainText) {
      const lines = plainText.split(/\r?\n/);
      
      const hasLeadingIndents = lines.some(l => {
        const trimmed = l.trim();
        return trimmed.length > 0 && l.match(/^\s{6,}/);
      });
      
      let inDialogue = false;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === '') {
          inDialogue = false;
          continue;
        }
        
        let type = 'action';
        let cleanText = trimmed;
        
        if (hasLeadingIndents) {
          const leadingSpaces = line.match(/^\s*/)[0].length;
          
          if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
            type = 'parenthetical';
            cleanText = trimmed.slice(1, -1).trim();
          } else if (trimmed.match(/^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/i)) {
            type = 'scene-heading';
            cleanText = trimmed.toUpperCase();
            inDialogue = false;
          } else if (leadingSpaces >= 32 && trimmed === trimmed.toUpperCase()) {
            type = 'transition';
            inDialogue = false;
          } else if (leadingSpaces >= 16 && trimmed === trimmed.toUpperCase() && trimmed.length < 35 && !trimmed.match(/^[0-9\.\-\#]+$/)) {
            type = 'character';
            inDialogue = true;
          } else if ((leadingSpaces >= 6 && leadingSpaces < 20) || inDialogue) {
            type = 'dialogue';
          } else {
            type = 'action';
            inDialogue = false;
          }
        } else {
          // Standard Semantic Parser
          if (trimmed.match(/^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/i)) {
            type = 'scene-heading';
            cleanText = trimmed.toUpperCase();
            inDialogue = false;
          } else if (trimmed.match(/^[A-Z\s]+ TO:$/) || trimmed.startsWith('>')) {
            type = 'transition';
            cleanText = trimmed.startsWith('>') ? trimmed.substring(1).trim().toUpperCase() : trimmed.toUpperCase();
            inDialogue = false;
          } else if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
            type = 'parenthetical';
            cleanText = trimmed.slice(1, -1).trim();
          } else if (trimmed === trimmed.toUpperCase() && trimmed.length < 35 && !trimmed.match(/^[0-9\.\-\#]+$/) && i < lines.length - 1 && lines[i+1].trim() !== '') {
            type = 'character';
            inDialogue = true;
          } else if (inDialogue) {
            type = 'dialogue';
          } else {
            type = 'action';
          }
        }
        
        parsedElements.push({ type, text: cleanText });
      }
    }
    
    // 3. Insert parsed HTML using document.execCommand to preserve browser undo history (Ctrl+Z)
    let htmlString = '';
    parsedElements.forEach(item => {
      const placeholder = elementPlaceholders[item.type] || '';
      htmlString += `<p class="element ${item.type}" placeholder="${placeholder}">${item.text}</p>`;
    });

    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const currentBlock = getParagraphAncestor(range.startContainer);
      if (currentBlock && currentBlock.textContent.trim() === '') {
        // Select INSIDE the empty block, rather than the block itself, 
        // to prevent Chrome's insertHTML from merging with the following sibling block.
        const blockRange = document.createRange();
        blockRange.selectNodeContents(currentBlock);
        selection.removeAllRanges();
        selection.addRange(blockRange);
      } else if (currentBlock && currentBlock.textContent.trim() !== '') {
        // Fix: If pasting at position 0 of a non-empty block (e.g. a scene heading),
        // move caret to just BEFORE the block so pasted elements don't inherit its class.
        const checkRange = range.cloneRange();
        checkRange.selectNodeContents(currentBlock);
        checkRange.setEnd(range.startContainer, range.startOffset);
        if (checkRange.toString().length === 0) {
          const beforeRange = document.createRange();
          beforeRange.setStartBefore(currentBlock);
          beforeRange.collapse(true);
          selection.removeAllRanges();
          selection.addRange(beforeRange);
        }
      }
    }

    document.execCommand('insertHTML', false, htmlString);
    
    normalizeEditorStructure();
    updateScriptAnalysis();
    highlightActiveLine();
    triggerAutoSave();

    // Scroll active block into view
    const active = editor.querySelector('.active-line');
    if (active) {
      active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // --- Document Block Normalizer ---
  // Guarantees all children in editor conform strictly to <p class="element [type]">
  function normalizeEditorStructure() {
    if (editor.innerHTML.trim() === '' || editor.children.length === 0) {
      editor.innerHTML = '<p class="element action" placeholder=""></p>';
      return;
    }

    let changed = false;
    const nodes = Array.from(editor.childNodes);
    
    // Get currently active element to skip replacing it while typing
    const selection = window.getSelection();
    let currentActiveP = null;
    if (selection.rangeCount > 0) {
      currentActiveP = getParagraphAncestor(selection.getRangeAt(0).startContainer);
    }

    nodes.forEach(node => {
      // Skip replacing currently active typing element to avoid losing cursor caret
      if (node === currentActiveP) return;

      // 1. Text node with content
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '') {
        const p = document.createElement('p');
        p.className = 'element action';
        p.setAttribute('placeholder', elementPlaceholders['action']);
        p.textContent = node.textContent;
        editor.replaceChild(p, node);
        changed = true;
      }
      // 2. Element nodes
      else if (node.nodeType === Node.ELEMENT_NODE) {
        const name = node.nodeName;
        // Divs or Paragraphs without element class
        if (name === 'DIV' || (name === 'P' && !node.classList.contains('element'))) {
          const p = document.createElement('p');
          
          let type = 'action';
          const className = (node.className || '').toLowerCase();
          if (className.includes('scene') || className.includes('heading')) type = 'scene-heading';
          else if (className.includes('character') || className.includes('char')) type = 'character';
          else if (className.includes('parenthetical') || className.includes('paren')) type = 'parenthetical';
          else if (className.includes('dialogue') || className.includes('dialog')) type = 'dialogue';
          else if (className.includes('transition')) type = 'transition';
          
          p.className = `element ${type}`;
          p.setAttribute('placeholder', elementPlaceholders[type] || 'Type here...');
          p.innerHTML = node.innerHTML;
          editor.replaceChild(p, node);
          changed = true;
        }
        // Bare Line Breaks (BRs)
        else if (name === 'BR') {
          if (editor.childNodes.length > 1) {
            editor.removeChild(node);
            changed = true;
          } else {
            const p = document.createElement('p');
            p.className = 'element action';
            p.setAttribute('placeholder', elementPlaceholders['action']);
            editor.replaceChild(p, node);
            changed = true;
          }
        }
      }
    });

    if (changed) {
      updateScriptAnalysis();
    }
  }

  // --- Smart Flow Core Logic ---

  const elementPlaceholders = {
    'scene-heading': 'INT. LOCATION - DAY',
    'action': '',
    'character': 'CHARACTER NAME',
    'parenthetical': 'attitude...',
    'dialogue': 'Dialogue text...',
    'transition': 'CUT TO:'
  };

  function handleSmartEnter(block, range, selection) {
    const currentType = getElementType(block);
    let nextType = 'action';

    // Transition Flow Chart
    if (currentType === 'scene-heading') nextType = 'action';
    else if (currentType === 'action') nextType = 'action';
    else if (currentType === 'character') nextType = 'dialogue';
    else if (currentType === 'dialogue') nextType = 'action';
    else if (currentType === 'parenthetical') nextType = 'dialogue';
    else if (currentType === 'transition') nextType = 'scene-heading';

    // Create New Block
    const newBlock = document.createElement('p');
    newBlock.className = `element ${nextType}`;
    newBlock.setAttribute('placeholder', elementPlaceholders[nextType]);

    // Split text node content at current caret offset
    const contentRange = range.cloneRange();
    contentRange.selectNodeContents(block);
    contentRange.setStart(range.startContainer, range.startOffset);
    
    const docFragment = contentRange.extractContents();
    newBlock.appendChild(docFragment);

    // Clean placeholder whitespace
    if (newBlock.textContent.trim() === '') {
      newBlock.innerHTML = '';
    }

    // Insert Block
    block.parentNode.insertBefore(newBlock, block.nextSibling);

    // Relocate Caret Focus to the beginning of the newly created block
    const newRange = document.createRange();
    newRange.setStart(newBlock, 0);
    newRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(newRange);

    newBlock.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

    // State cleanups
    activeBlock = newBlock;
    highlightActiveLine();
    updateScriptAnalysis();
  }

  function handleSmartTab(block) {
    const currentType = getElementType(block);
    let nextType = 'action';

    // Cycle layouts on Tab:
    // Action -> Character -> Parenthetical -> Dialogue -> Transition -> Scene Heading -> Action
    if (currentType === 'action') nextType = 'character';
    else if (currentType === 'character') nextType = 'parenthetical';
    else if (currentType === 'parenthetical') nextType = 'dialogue';
    else if (currentType === 'dialogue') nextType = 'transition';
    else if (currentType === 'transition') nextType = 'scene-heading';
    else if (currentType === 'scene-heading') nextType = 'action';

    changeBlockType(block, nextType);
  }

  function changeBlockType(block, type, isUndo = false, isRedo = false) {
    if (!block) return;

    // Push to format undo/redo stacks
    const prevType = getElementType(block);
    if (!isUndo && !isRedo && prevType !== type) {
      formatUndoStack.push({ block, oldType: prevType, newType: type, timestamp: Date.now() });
      formatRedoStack = []; // Clear redo stack on new action
    } else if (isUndo) {
      formatRedoStack.push({ block, oldType: type, newType: prevType, timestamp: Date.now() });
    } else if (isRedo) {
      formatUndoStack.push({ block, oldType: prevType, newType: type, timestamp: Date.now() });
    }
    
    // 1. Capture selection caret offset before altering block contents
    const selection = window.getSelection();
    let caretOffset = 0;
    let nodeHasFocus = false;
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (block.contains(range.startContainer)) {
        nodeHasFocus = true;
        
        // Calculate offset relative to start of block text
        const tempRange = range.cloneRange();
        tempRange.selectNodeContents(block);
        tempRange.setEnd(range.startContainer, range.startOffset);
        caretOffset = tempRange.toString().length;
      }
    }
    
    // Capture state to revert formatting properties
    let text = block.textContent;

    // Special cleanups
    if (type === 'parenthetical') {
      // Strip any manual parentheses typed since CSS adds them automatically
      text = text.replace(/^\(|\)$/g, '');
    }

    block.textContent = text;
    block.className = `element ${type}`;
    block.setAttribute('placeholder', elementPlaceholders[type] || 'Type here...');
    // Always clear inline styles so CSS class rules are never overridden
    block.style.cssText = '';
    
    // 2. Restore selection caret offset safely
    if (nodeHasFocus) {
      editor.focus();
      const newRange = document.createRange();
      newRange.selectNodeContents(block);
      
      // Find the text node to place the caret in
      let textNode = block.firstChild;
      if (textNode) {
        if (textNode.nodeType !== Node.TEXT_NODE) {
          // If not a text node, check children
          textNode = Array.from(block.childNodes).find(n => n.nodeType === Node.TEXT_NODE) || textNode;
        }
        
        if (textNode && textNode.nodeType === Node.TEXT_NODE) {
          const targetOffset = Math.min(caretOffset, textNode.textContent.length);
          newRange.setStart(textNode, targetOffset);
        } else {
          newRange.setStart(block, 0);
        }
      } else {
        newRange.setStart(block, 0);
      }
      
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }
    
    highlightActiveLine();
    updateScriptAnalysis();
  }

  // --- Dynamic Styling & Visual Helpers ---

  function highlightActiveLine() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    
    const currentBlock = getParagraphAncestor(selection.getRangeAt(0).startContainer);
    
    // Remove active highlighter classes from all blocks
    document.querySelectorAll('.paper .element').forEach(el => {
      el.classList.remove('active-line');
    });

    if (currentBlock) {
      activeBlock = currentBlock;
      currentBlock.classList.add('active-line');

      // Update indicator elements
      const type = getElementType(currentBlock);
      updateUIIndicators(type);
    }
  }

  function updateUIIndicators(type) {
    const displayNames = {
      'scene-heading': 'Scene Heading',
      'action': 'Action',
      'character': 'Character',
      'parenthetical': 'Parenthetical',
      'dialogue': 'Dialogue',
      'transition': 'Transition'
    };

    // 1. Update format picker button label and highlight the active option
    if (formatPickerLabel) formatPickerLabel.textContent = displayNames[type] || 'Action';
    formatOptions.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-type') === type);
    });

    // 3. Footer smart shortcut hints
    const hints = {
      'scene-heading': 'Press Enter to write Scene Action.',
      'action': 'Press Tab to center the line for a Character name.',
      'character': 'Press Enter to start Character Dialogue.',
      'parenthetical': 'Press Enter to continue with dialogue text.',
      'dialogue': 'Press Enter for Action, or Tab for Parentheticals.',
      'transition': 'Press Enter to start a new Scene Heading.'
    };
    shortcutHint.innerHTML = hints[type] || 'Press <kbd>Tab</kbd> or <kbd>Enter</kbd> for quick layout flow.';
  }

  function getParagraphAncestor(node) {
    let curr = node;
    while (curr && curr !== editor) {
      if (curr.nodeName === 'P' && curr.classList.contains('element')) {
        return curr;
      }
      curr = curr.parentNode;
    }
    return null;
  }

  function getElementType(block) {
    if (block.classList.contains('scene-heading')) return 'scene-heading';
    if (block.classList.contains('action')) return 'action';
    if (block.classList.contains('character')) return 'character';
    if (block.classList.contains('parenthetical')) return 'parenthetical';
    if (block.classList.contains('dialogue')) return 'dialogue';
    if (block.classList.contains('transition')) return 'transition';
    return 'action';
  }

  // --- Auto-complete Suggestion System ---

  function handleAutocompleteSearch() {
    if (!activeBlock) return closeAutocomplete();
    
    const type = getElementType(activeBlock);
    const text = activeBlock.textContent.trim().toUpperCase();

    if (text.length < 1) {
      return closeAutocomplete();
    }

    let matches = [];

    if (type === 'character') {
      matches = Array.from(castList).filter(name => name.startsWith(text) && name !== text);
    } else if (type === 'scene-heading') {
      const matchPrefixes = ['INT.', 'EXT.', 'INT/EXT.', 'I/E.', 'EST.'];
      const hasPrefix = matchPrefixes.some(p => text.startsWith(p));
      
      if (hasPrefix) {
        // Find matching suffixes or complete locations
        const prefix = matchPrefixes.find(p => text.startsWith(p));
        const rest = text.substring(prefix.length).trim();
        
        if (rest.length > 0) {
          matches = Array.from(locationList)
            .filter(loc => loc.startsWith(rest))
            .map(loc => `${prefix} ${loc}`);
        }
      } else {
        // Suggest prefixes themselves
        matches = matchPrefixes.filter(p => p.startsWith(text));
      }
    }

    if (matches.length > 0) {
      showAutocomplete(matches);
    } else {
      closeAutocomplete();
    }
  }

  function showAutocomplete(suggestions) {
    currentSuggestions = suggestions;
    suggestionIndex = 0;
    
    autocompleteBox.innerHTML = '';
    suggestions.forEach((s, idx) => {
      const li = document.createElement('li');
      li.className = `autocomplete-item ${idx === 0 ? 'selected' : ''}`;
      li.textContent = s;
      
      // Use mousedown instead of click to prevent focus loss in the editor
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Retain editor focus
        suggestionIndex = idx;
        acceptSuggestion();
      });
      autocompleteBox.appendChild(li);
    });

    // Position box relative to selection caret
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      
      autocompleteBox.style.left = `${rect.left + window.scrollX}px`;
      autocompleteBox.style.top = `${rect.bottom + window.scrollY + 5}px`;
      autocompleteBox.style.display = 'block';
    }
  }

  function navigateSuggestions(dir) {
    const items = autocompleteBox.querySelectorAll('.autocomplete-item');
    if (!items.length) return;

    items[suggestionIndex].classList.remove('selected');
    
    suggestionIndex += dir;
    if (suggestionIndex >= items.length) suggestionIndex = 0;
    if (suggestionIndex < 0) suggestionIndex = items.length - 1;
    
    items[suggestionIndex].classList.add('selected');
    items[suggestionIndex].scrollIntoView({ block: 'nearest' });
  }

  function acceptSuggestion() {
    if (suggestionIndex >= 0 && suggestionIndex < currentSuggestions.length) {
      const val = currentSuggestions[suggestionIndex];
      activeBlock.textContent = val;
      
      // Move caret to end of replaced text
      const range = document.createRange();
      const selection = window.getSelection();
      range.setStart(activeBlock.firstChild, val.length);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      
      closeAutocomplete();
      updateScriptAnalysis();
    }
  }

  function closeAutocomplete() {
    autocompleteBox.style.display = 'none';
    currentSuggestions = [];
    suggestionIndex = -1;
  }

  // --- Real-time Outline, Stats & Registries ---

  function updateScriptAnalysis() {
    const paragraphs = editor.querySelectorAll('.element');
    
    let sceneCount = 0;
    let wordCount = 0;
    let charCount = 0;
    
    const newCast = new Set();
    const newLocations = new Set();
    
    // Clear list view HTML
    sceneList.innerHTML = '';

    paragraphs.forEach((p, idx) => {
      const text = p.textContent.trim();
      const type = getElementType(p);
      
      // Calculate Stats
      if (text.length > 0) {
        wordCount += text.split(/\s+/).length;
        charCount += text.length;
      }

      // 1. Process Scene Outline & Locations
      if (type === 'scene-heading') {
        sceneCount++;
        const li = document.createElement('li');
        li.className = 'scene-item';
        const sceneTitle = text.toUpperCase() || 'UNTITLED SCENE';
        li.textContent = `${sceneCount}. ${sceneTitle}`;
        li.title = `Scroll to scene ${sceneCount}: ${sceneTitle}`;
        li.addEventListener('click', () => {
          p.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Flash highlight - use a CSS class so we don't leave stale inline styles
          p.classList.add('flash-highlight');
          setTimeout(() => {
            p.classList.remove('flash-highlight');
          }, 800);
        });
        sceneList.appendChild(li);

        // Registry locations indexing (starts with prefix e.g. INT.)
        const match = text.match(/^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)\s*(.+)$/i);
        if (match && match[1].trim() !== '') {
          newLocations.add(match[1].trim().toUpperCase());
        }
      }

      // 2. Process Characters cast list
      if (type === 'character' && text !== '') {
        newCast.add(text.toUpperCase());
      }
    });

    // Populate Empty scene placeholder
    if (sceneCount === 0) {
      const li = document.createElement('li');
      li.className = 'empty-outline-msg';
      li.textContent = 'Add a Scene Heading (e.g. INT. HALLWAY - DAY) to start mapping your outline.';
      sceneList.appendChild(li);
    }

    // Update global registries
    castList = newCast;
    locationList = newLocations;
    
    // Update Badge & UI indicators
    sceneCountBadge.textContent = sceneCount;
    statWords.textContent = wordCount.toLocaleString();
    
    // Calculate page counts using standard continuous layout height (approx 900px per page printable height)
    const pageEstimate = Math.max(1, Math.ceil(editor.scrollHeight / 900));
    statPages.textContent = pageEstimate;

    // Populate Cast Sidebar Panel List
    populateRegistriesUI();
  }

  /**
   * enforcePageBreaks()
   * Scans every element in the editor and ensures no element crosses a page
   * boundary. If an element's bottom edge extends past the current page's
   * content zone, it receives extra margin-top to push it onto the next page.
   * Uses a single forward pass — since each push is applied immediately, later
   * elements automatically reflect the updated layout.
   */
  function enforcePageBreaks() {
    const elements = Array.from(editor.querySelectorAll('.element'));

    // 1. Reset any previously injected page-break margins
    for (const el of elements) {
      if (el.dataset.pageBreak) {
        el.style.marginTop = '';
        delete el.dataset.pageBreak;
      }
    }

    // 2. Ensure the first element starts below the top margin of page 1
    if (elements.length > 0) {
      const first = elements[0];
      const currentTop = first.offsetTop;
      if (currentTop < PAGE_MARGIN_TOP) {
        const needed = PAGE_MARGIN_TOP - currentTop;
        const existing = parseFloat(getComputedStyle(first).marginTop) || 0;
        first.style.marginTop = `${existing + needed}px`;
        first.dataset.pageBreak = 'first';
      }
    }

    // 3. Forward pass — push elements that cross page boundaries
    for (const el of elements) {
      // Skip first element if already handled
      if (el.dataset.pageBreak === 'first') continue;

      const elTop = el.offsetTop;
      const elBottom = elTop + el.offsetHeight;

      // Which page does the TOP of this element belong to?
      const pageIndex = Math.floor(elTop / FULL_PAGE);

      // Content zone boundaries for this page
      const contentBottom = pageIndex * FULL_PAGE + PAGE_HEIGHT - PAGE_MARGIN_BOTTOM;
      const nextContentTop = (pageIndex + 1) * FULL_PAGE + PAGE_MARGIN_TOP;

      // Case 1: Element extends past the content zone bottom → push to next page
      // Case 2: Element starts in the gap or top-margin zone → push to next page
      const inGapOrMargin = elTop >= contentBottom && elTop < nextContentTop;

      if (elBottom > contentBottom || inGapOrMargin) {
        const push = nextContentTop - elTop;

        if (push > 0 && push < FULL_PAGE) {
          el.style.marginTop = `${push}px`;
          el.dataset.pageBreak = String(push);
        }
      }
    }

    // 4. Ensure paper min-height covers the last page fully
    const lastEl = elements[elements.length - 1];
    if (lastEl) {
      const lastBottom = lastEl.offsetTop + lastEl.offsetHeight;
      const lastPage = Math.floor(lastBottom / FULL_PAGE);
      const requiredHeight = (lastPage + 1) * FULL_PAGE;
      editor.style.minHeight = `${Math.max(PAGE_HEIGHT, requiredHeight)}px`;
    }
  }

  // Generate non-interactive, absolutely positioned visual page numbers
  function updatePageNumbers() {
    editor.querySelectorAll('.page-number-indicator').forEach(el => el.remove());

    const totalHeight = editor.scrollHeight;
    const pageCount = Math.max(1, Math.ceil(totalHeight / FULL_PAGE));

    for (let i = 1; i <= pageCount; i++) {
      const pageNum = document.createElement('span');
      pageNum.className = 'page-number-indicator';
      pageNum.contentEditable = 'false';
      pageNum.textContent = `${i}.`;
      
      // Position in top-right margin area of each page
      const topOffset = (i - 1) * FULL_PAGE + 36;
      pageNum.style.top = `${topOffset}px`;
      
      editor.appendChild(pageNum);
    }
  }

  function populateRegistriesUI() {
    // 1. Character registry HTML
    charactersRegistry.innerHTML = '';
    if (castList.size > 0) {
      castList.forEach(name => {
        const li = document.createElement('li');
        li.className = 'registry-item';
        li.innerHTML = `<span>${name}</span>`;
        charactersRegistry.appendChild(li);
      });
    } else {
      charactersRegistry.innerHTML = '<li class="empty-msg">No characters detected yet.</li>';
    }

    // 2. Locations registry HTML
    locationsRegistry.innerHTML = '';
    if (locationList.size > 0) {
      locationList.forEach(loc => {
        const li = document.createElement('li');
        li.className = 'registry-item';
        li.innerHTML = `<span>${loc}</span>`;
        locationsRegistry.appendChild(li);
      });
    } else {
      locationsRegistry.innerHTML = '<li class="empty-msg">No locations detected yet.</li>';
    }
  }

  // --- Auto-Save & LocalStorage ---

  function triggerAutoSave() {
    saveStatus.textContent = "Saving...";
    saveStatus.classList.remove('status-success', 'status-error');
    saveStatus.classList.add('status-saving');
    saveStatus.style.opacity = "1";
    
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => {
      saveScriptToLocalStorage();
      showSaveFlash("Auto-Saved");
    }, 1200);
  }

  function saveScriptToLocalStorage() {
    const title = scriptTitleInput.value || 'Untitled Screenplay';
    const content = editor.innerHTML;

    localStorage.setItem('screenflow_title_' + currentScriptId, title);
    localStorage.setItem('screenflow_script_' + currentScriptId, content);

    // Fallbacks
    localStorage.setItem('screenflow_title', title);
    localStorage.setItem('screenflow_script', content);
    
    updateRecentsList(currentScriptId, title);

    // Background Auto-Save to Local Disk if FileSystemFileHandle is active
    if (activeFileHandle) {
      const paragraphs = editor.querySelectorAll('.element');
      let fountainOutput = `Title: ${title}\n\n`;
      let lastType = '';

      paragraphs.forEach(p => {
        const type = getElementType(p);
        const text = p.textContent.trim();
        if (text === '') return;

        switch(type) {
          case 'scene-heading': fountainOutput += `\n${text.toUpperCase()}\n`; break;
          case 'character': fountainOutput += `\n${text.toUpperCase()}\n`; break;
          case 'parenthetical': fountainOutput += `(${text})\n`; break;
          case 'dialogue': fountainOutput += `${text}\n`; break;
          case 'transition': fountainOutput += `\n${text.toUpperCase()}\n`; break;
          case 'action':
          default: fountainOutput += `\n${text}\n`; break;
        }
        lastType = type;
      });

      fountainOutput = fountainOutput.replace(/\n{3,}/g, '\n\n');

      activeFileHandle.createWritable().then(writable => {
        writable.write(fountainOutput).then(() => {
          writable.close().then(() => {
            saveStatus.textContent = "Synced to Disk";
            saveStatus.classList.remove('status-saving', 'status-error');
            saveStatus.classList.add('status-success');
          });
        });
      }).catch(err => {
        console.error("Continuous auto-save write failed:", err);
      });
    }
  }

  function loadScriptFromLocalStorage() {
    // Migrate legacy keys if present
    if (!localStorage.getItem('screenflow_title_' + currentScriptId) && localStorage.getItem('screenflow_script')) {
      const legacyTitle = localStorage.getItem('screenflow_title') || 'Untitled Screenplay';
      const legacyScript = localStorage.getItem('screenflow_script');
      localStorage.setItem('screenflow_title_' + currentScriptId, legacyTitle);
      localStorage.setItem('screenflow_script_' + currentScriptId, legacyScript);
      updateRecentsList(currentScriptId, legacyTitle);
    }

    const savedTitle = localStorage.getItem('screenflow_title_' + currentScriptId);
    const savedScript = localStorage.getItem('screenflow_script_' + currentScriptId);
    
    if (savedTitle !== null) {
      scriptTitleInput.value = savedTitle;
    }
    if (savedScript !== null && savedScript.trim() !== '') {
      editor.innerHTML = savedScript;
      // Strip out any saved margin-tops or indicator elements
      editor.querySelectorAll('.element').forEach(el => {
        el.style.marginTop = '';
        if (el.dataset.pageBreak) delete el.dataset.pageBreak;
      });
      // Strip any stale inline styles from scene headings that would override CSS
      editor.querySelectorAll('.element.scene-heading').forEach(el => {
        el.style.backgroundColor = '';
        el.style.padding = '';
        el.style.marginLeft = '';
        el.style.marginRight = '';
        el.style.borderRadius = '';
      });
      editor.querySelectorAll('.page-number-indicator').forEach(el => el.remove());
    }
  }

  function showSaveFlash(msg) {
    saveStatus.textContent = msg;
    saveStatus.classList.remove('status-saving', 'status-error');
    saveStatus.classList.add('status-success');
    saveStatus.style.opacity = "1";
    setTimeout(() => {
      saveStatus.style.opacity = "0.7";
    }, 2000);
  }

  function clearEditorScript() {
    if (confirm("Are you absolutely sure you want to clear your current screenplay? This cannot be undone.")) {
      editor.innerHTML = '<p class="element scene-heading">INT. NEW SCENE - DAY</p><p class="element action">Type your screenplay action here...</p>';
      scriptTitleInput.value = "Untitled Screenplay";
      saveScriptToLocalStorage();
      updateScriptAnalysis();
      editor.focus();
    }
  }

  // --- Fountain Format Plain-Text Import/Export ---

  async function exportFountainText() {
    const title = (scriptTitleInput.value || 'Untitled Screenplay').trim();
    const paragraphs = editor.querySelectorAll('.element');
    let fountainOutput = `Title: ${title}\n\n`;
    
    let lastType = '';

    paragraphs.forEach(p => {
      const type = getElementType(p);
      const text = p.textContent.trim();
      
      if (text === '') return;

      switch(type) {
        case 'scene-heading':
          fountainOutput += `\n${text.toUpperCase()}\n`;
          break;
        case 'character':
          fountainOutput += `\n${text.toUpperCase()}\n`;
          break;
        case 'parenthetical':
          fountainOutput += `(${text})\n`;
          break;
        case 'dialogue':
          fountainOutput += `${text}\n`;
          break;
        case 'transition':
          fountainOutput += `\n${text.toUpperCase()}\n`;
          break;
        case 'action':
        default:
          fountainOutput += `\n${text}\n`;
          break;
      }
      lastType = type;
    });

    // Clean duplicate double spaces/newlines
    fountainOutput = fountainOutput.replace(/\n{3,}/g, '\n\n');

    // Attempt to use File System Access API for precise filename overwriting / auto-saves
    if (window.showSaveFilePicker) {
      try {
        let handle = activeFileHandle;
        
        if (!handle) {
          // Build picker options, injecting last-used directory handle if available
          const pickerOpts = {
            suggestedName: `${title}.fountain`,
            types: [{
              description: 'Fountain Screenplay',
              accept: {'text/plain': ['.fountain', '.txt']}
            }]
          };

          // Try to restore last-saved directory handle from IndexedDB
          const lastDirHandle = await idbGet('screenflow_last_dir_handle');
          if (lastDirHandle) {
            try {
              const perm = await lastDirHandle.queryPermission({ mode: 'readwrite' });
              if (perm === 'granted' || perm === 'prompt') {
                pickerOpts.startIn = lastDirHandle;
              }
            } catch (_) {}
          }

          handle = await window.showSaveFilePicker(pickerOpts);
          activeFileHandle = handle;

          // Persist the parent directory for next time
          try {
            await idbSet('screenflow_last_dir_handle', handle);
          } catch (_) {}
        }

        const writable = await handle.createWritable();
        await writable.write(fountainOutput);
        await writable.close();
        showSaveFlash("Saved to Disk!");
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('File System Access API failed', err);
      }
    }

    // Fallback: Download via <a> (browser may append (1) if exists)
    const blob = new Blob([fountainOutput], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${title}.fountain`;
    link.click();
    
    showSaveFlash("Exported Fountain Script!");
  }

  async function importFountainText(e) {
    // If browser supports modern File System Access API
    if (window.showOpenFilePicker) {
      try {
        // Build picker options, injecting last-used directory handle if available
        const pickerOpts = {
          types: [{
            description: 'Fountain Screenplay',
            accept: { 'text/plain': ['.fountain', '.txt'] }
          }],
          excludeAcceptAllOption: true,
          multiple: false
        };

        // Try to restore last-opened directory handle from IndexedDB
        const lastDirHandle = await idbGet('screenflow_last_open_dir_handle');
        if (lastDirHandle) {
          try {
            const perm = await lastDirHandle.queryPermission({ mode: 'read' });
            if (perm === 'granted' || perm === 'prompt') {
              pickerOpts.startIn = lastDirHandle;
            }
          } catch (_) {}
        }

        const [handle] = await window.showOpenFilePicker(pickerOpts);

        activeFileHandle = handle;
        const file = await handle.getFile();
        parseAndLoadFountain(file);

        // Persist the file handle so the picker remembers this directory next time
        try {
          await idbSet('screenflow_last_open_dir_handle', handle);
        } catch (_) {}

        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('File System Access Open failed', err);
      }
    }

    // Fallback: Trigger standard input type=file click
    const fileInput = document.getElementById('import-fountain-file');
    if (fileInput) {
      fileInput.click();
    }
  }

  // Helper for type=file fallback change listener
  function handleFallbackFileImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    activeFileHandle = null; // Raw upload, no active file handle
    parseAndLoadFountain(file);
    e.target.value = '';
  }

  function parseAndLoadFountain(file) {
    const reader = new FileReader();
    reader.onload = function(evt) {
      const text = evt.target.result;
      
      const lines = text.split(/\r?\n/);
      let importedHTML = '';
      let inDialogue = false;
      let titleFound = false;

      const fallbackTitle = file.name.replace(/\.[^/.]+$/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        
        if (!titleFound && line.toLowerCase().startsWith('title:')) {
          const titleVal = line.substring(6).trim();
          if (titleVal !== '') {
            scriptTitleInput.value = titleVal;
            titleFound = true;
          }
          continue;
        }

        if (line.match(/^(author|authors|source|draft|date|contact|copyright):\s*(.*)$/i)) {
          continue;
        }

        if (line === '') {
          inDialogue = false;
          continue;
        }

        if (line.match(/^(INT\.|EXT\.|INT\/EXT\.|I\/E\.|EST\.)/i)) {
          importedHTML += `<p class="element scene-heading">${line.toUpperCase()}</p>`;
          inDialogue = false;
        }
        else if (line.match(/^[A-Z\s]+ TO:$/) || line.startsWith('>')) {
          const cleanLine = line.startsWith('>') ? line.substring(1).trim() : line;
          importedHTML += `<p class="element transition">${cleanLine.toUpperCase()}</p>`;
          inDialogue = false;
        }
        else if (line.startsWith('(') && line.endsWith(')')) {
          const cleanLine = line.slice(1, -1);
          importedHTML += `<p class="element parenthetical">${cleanLine}</p>`;
        }
        else if (line === line.toUpperCase() && !line.match(/^[0-9\.\-\#]+$/) && i < lines.length - 1 && lines[i+1].trim() !== '') {
          importedHTML += `<p class="element character">${line}</p>`;
          inDialogue = true;
        }
        else if (inDialogue) {
          importedHTML += `<p class="element dialogue">${line}</p>`;
        }
        else {
          importedHTML += `<p class="element action">${line}</p>`;
        }
      }

      if (importedHTML.trim() !== '') {
        currentScriptId = 'script_' + Date.now();
        localStorage.setItem('screenflow_current_id', currentScriptId);

        if (!titleFound) {
          scriptTitleInput.value = fallbackTitle;
        }

        editor.innerHTML = importedHTML;
        editor.querySelectorAll('.element').forEach(el => {
          el.style.marginTop = '';
          if (el.dataset.pageBreak) delete el.dataset.pageBreak;
        });

        updateScriptAnalysis();
        saveScriptToLocalStorage();
        highlightActiveLine();
        showSaveFlash("Fountain Script Loaded!");
      } else {
        alert("Failed to parse standard Fountain elements from text file.");
      }
    };
    
    reader.readAsText(file);
  }

  function setupDragAndDrop() {
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) {
        if (file.name.endsWith('.fountain') || file.name.endsWith('.txt')) {
          parseAndLoadFountain(file);
        } else {
          alert("Please drop a standard .fountain or .txt screenplay file.");
        }
      }
    });
  }

  function updateRecentsList(id, title) {
    let recents = [];
    try {
      recents = JSON.parse(localStorage.getItem('screenflow_recents')) || [];
    } catch(e) {
      recents = [];
    }

    recents = recents.filter(item => item.id !== id);
    recents.unshift({
      id: id,
      title: title,
      lastModified: Date.now()
    });

    if (recents.length > 8) {
      recents = recents.slice(0, 8);
    }

    localStorage.setItem('screenflow_recents', JSON.stringify(recents));
    renderRecentsUI();
  }

  function renderRecentsUI() {
    const recentScriptsList = document.getElementById('recent-scripts-list');
    if (!recentScriptsList) return;

    recentScriptsList.innerHTML = '';
    let recents = [];
    try {
      recents = JSON.parse(localStorage.getItem('screenflow_recents')) || [];
    } catch(e) {
      recents = [];
    }

    if (recents.length === 0) {
      recentScriptsList.innerHTML = '<li class="empty-msg" style="padding: 6px 0; font-size: 0.75rem;">No recent scripts</li>';
      return;
    }

    recents.forEach(item => {
      const li = document.createElement('li');
      li.className = 'recent-script-item';
      if (item.id === currentScriptId) {
        li.style.borderColor = 'var(--accent-color)';
        li.style.backgroundColor = 'var(--accent-light)';
      }

      const titleSpan = document.createElement('span');
      titleSpan.className = 'recent-title';
      titleSpan.textContent = item.title || 'Untitled Screenplay';
      titleSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        loadRecentScript(item.id);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'delete-recent-btn';
      deleteBtn.innerHTML = '<i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRecentScript(item.id);
      });

      li.appendChild(titleSpan);
      li.appendChild(deleteBtn);
      recentScriptsList.appendChild(li);
    });

    lucide.createIcons();
  }

  function loadRecentScript(id) {
    saveScriptToLocalStorage();

    currentScriptId = id;
    localStorage.setItem('screenflow_current_id', currentScriptId);

    const savedTitle = localStorage.getItem('screenflow_title_' + id);
    const savedScript = localStorage.getItem('screenflow_script_' + id);

    if (savedTitle !== null) {
      scriptTitleInput.value = savedTitle;
    } else {
      scriptTitleInput.value = "Untitled Screenplay";
    }

    if (savedScript !== null && savedScript.trim() !== '') {
      editor.innerHTML = savedScript;
      editor.querySelectorAll('.element').forEach(el => {
        el.style.marginTop = '';
        if (el.dataset.pageBreak) delete el.dataset.pageBreak;
      });
    } else {
      editor.innerHTML = '<p class="element scene-heading">INT. NEW SCENE - DAY</p><p class="element action"></p>';
    }

    updateScriptAnalysis();
    highlightActiveLine();
    renderRecentsUI();
    showSaveFlash("Script Loaded");
  }

  function deleteRecentScript(id) {
    if (!confirm("Are you sure you want to delete this screenplay draft? This cannot be undone.")) {
      return;
    }

    localStorage.removeItem('screenflow_title_' + id);
    localStorage.removeItem('screenflow_script_' + id);
    
    // Clean up metadata keys
    localStorage.removeItem(`screenflow_meta_title_${id}`);
    localStorage.removeItem(`screenflow_meta_author_${id}`);
    localStorage.removeItem(`screenflow_meta_contact_${id}`);

    let recents = [];
    try {
      recents = JSON.parse(localStorage.getItem('screenflow_recents')) || [];
    } catch(e) {
      recents = [];
    }

    recents = recents.filter(item => item.id !== id);
    localStorage.setItem('screenflow_recents', JSON.stringify(recents));

    if (id === currentScriptId) {
      // Always create a brand new blank document when deleting the active script
      activeFileHandle = null;
      currentScriptId = 'script_' + Date.now();
      localStorage.setItem('screenflow_current_id', currentScriptId);

      scriptTitleInput.value = "Untitled Screenplay";
      editor.innerHTML = '<p class="element action" placeholder=""></p>';

      saveScriptToLocalStorage();
      updateScriptAnalysis();
      highlightActiveLine();
      renderRecentsUI();
      editor.focus();
      showSaveFlash("New Draft Created");
    } else {
      renderRecentsUI();
    }
  }


  function createNewScript() {
    saveScriptToLocalStorage();

    currentScriptId = 'script_' + Date.now();
    localStorage.setItem('screenflow_current_id', currentScriptId);

    scriptTitleInput.value = "Untitled Screenplay";
    editor.innerHTML = '<p class="element scene-heading">INT. STUDY - DAY</p><p class="element action"></p>';
    
    saveScriptToLocalStorage();
    updateScriptAnalysis();
    highlightActiveLine();
    editor.focus();
    showSaveFlash("New Draft Created");
  }

  // --- UI Layout Toggles ---

  function collapseSidebar() {
    sidebar.classList.add('collapsed');
    document.body.classList.add('sidebar-is-collapsed');
    localStorage.setItem('screenflow_sidebar_collapsed', 'true');
  }

  function expandSidebar() {
    sidebar.classList.remove('collapsed');
    document.body.classList.remove('sidebar-is-collapsed');
    localStorage.setItem('screenflow_sidebar_collapsed', 'false');
  }

  function toggleTheme() {
    const isDark = document.documentElement.classList.contains('dark-theme');
    const themeIcon = document.getElementById('theme-toggle-icon');
    
    if (isDark) {
      document.documentElement.classList.remove('dark-theme');
      document.documentElement.classList.add('light-theme');
      if (themeIcon) {
        themeIcon.setAttribute('data-lucide', 'moon');
      }
      themeToggleBtn.setAttribute('title', 'Switch to Dark Slate Theme');
      localStorage.setItem('screenflow_theme', 'light-theme');
    } else {
      document.documentElement.classList.remove('light-theme');
      document.documentElement.classList.add('dark-theme');
      if (themeIcon) {
        themeIcon.setAttribute('data-lucide', 'sun');
      }
      themeToggleBtn.setAttribute('title', 'Switch to Crisp Paper Theme');
      localStorage.setItem('screenflow_theme', 'dark-theme');
    }
    
    lucide.createIcons();
  }

  // Show/hide stat spans and the dividers flanking them in footer-right
  function setStatDividersVisible(visible) {
    if (!footerStatPages || !footerStatWords) return;
    // Toggle the stat spans themselves
    footerStatPages.classList.toggle('hidden', !visible);
    footerStatWords.classList.toggle('hidden', !visible);
    // Hide/show the divider between stats and auto-save (next sibling of footerStatWords)
    const divAfterWords = footerStatWords.nextElementSibling;
    if (divAfterWords && divAfterWords.classList.contains('divider')) {
      divAfterWords.style.display = visible ? '' : 'none';
    }
    // Hide/show the divider between pages and words
    const divBetween = footerStatPages.nextElementSibling;
    if (divBetween && divBetween.classList.contains('divider')) {
      divBetween.style.display = visible ? '' : 'none';
    }
  }

  function openHelpModal() {
    helpModal.classList.add('active');
  }

  function saveAsPDF() {
    let jsPDFClass = null;
    if (window.jspdf && window.jspdf.jsPDF) {
      jsPDFClass = window.jspdf.jsPDF;
    } else if (window.jsPDF) {
      jsPDFClass = window.jsPDF;
    }

    if (!jsPDFClass) {
      alert("PDF generation library not loaded. Please try again in a moment.");
      return;
    }

    // Create PDF: portrait, points (pt), letter size
    const doc = new jsPDFClass({
      orientation: 'portrait',
      unit: 'pt',
      format: 'letter'
    });

    // Fonts and standard sizes
    doc.setFont('Courier', 'normal');
    doc.setFontSize(12);

    const paragraphs = editor.querySelectorAll('.element');
    const title = scriptTitleInput.value || 'Untitled Screenplay';

    // Retrieve Title Page Metadata
    const metaTitle = localStorage.getItem(`screenflow_meta_title_${currentScriptId}`) || title;
    const metaAuthor = localStorage.getItem(`screenflow_meta_author_${currentScriptId}`) || '';
    const metaContact = localStorage.getItem(`screenflow_meta_contact_${currentScriptId}`) || '';

    let isFirstPageForScreenplay = true;

    // Check if we have any substantial metadata to print a Title Page
    const hasTitlePage = metaTitle || metaAuthor || metaContact;
    if (hasTitlePage) {
      isFirstPageForScreenplay = false;

      // 1. Draw Title (centered horizontally, ~1/3 down the page)
      doc.setFont('Courier', 'bold');
      doc.setFontSize(18);
      const titleLines = doc.splitTextToSize(metaTitle.toUpperCase(), 360);
      let titleY = 280;
      titleLines.forEach(line => {
        doc.text(line, 306, titleY, { align: 'center' }); // 306 pt is exactly center of 612 pt page width
        titleY += 18;
      });

      // 2. Draw Author Details (centered horizontally, ~1/2 down page)
      doc.setFont('Courier', 'normal');
      doc.setFontSize(12);
      let midY = 360;

      doc.text("by", 306, midY, { align: 'center' });
      midY += 24;

      if (metaAuthor.trim() !== '') {
        const authorLines = doc.splitTextToSize(metaAuthor, 300);
        authorLines.forEach(line => {
          doc.text(line, 306, midY, { align: 'center' });
          midY += 14;
        });
      } else {
        doc.text("Anonymous", 306, midY, { align: 'center' });
      }

      // 3. Draw Contact Details (bottom left corner, ~1.5 inch margins)
      if (metaContact.trim() !== '') {
        doc.setFont('Courier', 'normal');
        doc.setFontSize(10);
        const contactLines = doc.splitTextToSize(metaContact, 300);
        let contactY = 660 - (contactLines.length * 12); // bottom aligned
        contactLines.forEach(line => {
          doc.text(line, 108, contactY); // Align with 1.5 in left margin
          contactY += 12;
        });
      }

      // Add a page break to start the screenplay text
      doc.addPage();
    }

    doc.setFont('Courier', 'normal');
    doc.setFontSize(12);

    let y = 72; // 1 inch from top
    const maxY = 720; // 10 inches from top (leaving 1 inch bottom margin)
    const lineHeight = 14;

    paragraphs.forEach((p, idx) => {
      const text = p.textContent.trim();
      if (text === '' && idx > 0) return; // skip empty lines

      const type = getElementType(p);

      // Standard margins and widths in points
      let leftMargin = 108; // 1.5 in
      let width = 432;      // 6.0 in (8.5in total - 1.5in left - 1.0in right)
      let align = 'left';

      if (type === 'scene-heading') {
        leftMargin = 108;
        width = 432;
        doc.setFont('Courier', 'bold');
        if (y > 72) {
          y += 24; // 2 blank lines space
        }
      } else if (type === 'action') {
        leftMargin = 108;
        width = 432;
        doc.setFont('Courier', 'normal');
        if (y > 72) {
          y += 12; // 1 blank line space
        }
      } else if (type === 'character') {
        leftMargin = 266.4; // 3.7 in
        width = 252;        // 3.5 in
        doc.setFont('Courier', 'normal');
        if (y > 72) {
          y += 12;
        }
      } else if (type === 'parenthetical') {
        leftMargin = 223.2; // 3.1 in
        width = 144;        // 2.0 in
        doc.setFont('Courier', 'normal');
      } else if (type === 'dialogue') {
        leftMargin = 180;   // 2.5 in
        width = 252;        // 3.5 in
        doc.setFont('Courier', 'normal');
      } else if (type === 'transition') {
        leftMargin = 108;
        width = 432;
        align = 'right';
        doc.setFont('Courier', 'normal');
        if (y > 72) {
          y += 12;
        }
      }

      let contentText = text;
      if (type === 'character' || type === 'scene-heading' || type === 'transition') {
        contentText = contentText.toUpperCase();
      } else if (type === 'parenthetical') {
        if (!contentText.startsWith('(')) contentText = '(' + contentText;
        if (!contentText.endsWith(')')) contentText = contentText + ')';
      }

      const lines = doc.splitTextToSize(contentText, width);

      // Check for page break before writing paragraph
      const neededSpace = lines.length * lineHeight;
      let extraCheck = 0;
      if (type === 'character') {
        extraCheck = lineHeight * 2; // character + line of dialogue
      } else if (type === 'scene-heading') {
        extraCheck = lineHeight * 3; // heading + action/character
      }

      if (y + neededSpace + extraCheck > maxY) {
        doc.addPage();
        y = 72;
      }

      // Write each line
      lines.forEach((lineText) => {
        if (y + lineHeight > maxY) {
          doc.addPage();
          y = 72;
        }

        if (align === 'right') {
          doc.text(lineText, 540, y + 10, { align: 'right' }); // 540 pt = 7.5 in (right margin)
        } else {
          doc.text(lineText, leftMargin, y + 10);
        }
        y += lineHeight;
      });
    });

    // Add Page Numbers (standard industry formatting: page 1 of script has no page number)
    const totalPages = doc.internal.getNumberOfPages();
    const startNumberingFromPage = hasTitlePage ? 3 : 2;
    for (let i = startNumberingFromPage; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFont('Courier', 'normal');
      doc.setFontSize(12);
      const displayPageNum = hasTitlePage ? i - 1 : i;
      doc.text(`${displayPageNum}.`, 540, 36, { align: 'right' }); // 0.5 in from top, right aligned to 7.5 in
    }

    // Trigger direct download to Scripts subfolder
    doc.save(`${title}.pdf`);
    showSaveFlash("PDF Saved!");
  }

  function closeHelpModal() {
    helpModal.classList.remove('active');
  }
});

// Main app orchestration — library, uploads, reader state, preferences, TTS.
(() => {
  const el = (id) => document.getElementById(id);
  const libraryView = el('library');
  const readerView = el('reader');
  const bookGrid = el('book-grid');
  const dropZone = el('drop-zone');
  const fileInput = el('file-input');
  const addBtn = el('add-btn');
  const backBtn = el('back-btn');
  const prevBtn = el('prev-btn');
  const nextBtn = el('next-btn');
  const progressEl = el('progress');
  const progressLabel = el('progress-label');
  const readerTitle = el('reader-title');
  const loading = el('loading');
  const scrim = el('scrim');
  const toast = el('toast');
  const tocBtn = el('toc-btn');
  const bookmarkBtn = el('bookmark-btn');
  const ttsBtn = el('tts-btn');
  const readerSettingsBtn = el('reader-settings-btn');
  const settingsBtn = el('settings-btn');
  const tocDrawer = el('toc-drawer');
  const settingsDrawer = el('settings-drawer');
  const readerSettingsDrawer = el('reader-settings-drawer');
  const tocList = el('toc-list');
  const bookmarksList = el('bookmarks-list');
  const voiceSelect = el('voice-select');
  const useEchoToggle = el('use-echo');
  const rateEl = el('rate');
  const rateLabel = el('rate-label');
  const storageInfo = el('storage-info');
  const fontSizeLabel = el('font-size-label');

  const app = {
    currentBookId: null,
    currentState: null,     // state record from DB
    ttsActive: false,
    savingTimer: null,
    prefs: {
      theme: 'dark',
      fontScale: 0,
      fontFamily: 'serif',
      spacing: 1.6,
      rate: 1.0,
      voiceURI: null,
      useEcho: true,
    },
  };

  // -------------------- Toast --------------------
  let toastTimer;
  function showToast(msg, ms = 2200) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), ms);
  }

  // -------------------- Prefs --------------------
  async function loadPrefs() {
    const p = await DB.getPref('prefs', app.prefs);
    Object.assign(app.prefs, p);
    Reader.setTheme(app.prefs.theme);
    Reader.setFontScale(app.prefs.fontScale);
    Reader.setFontFamily(app.prefs.fontFamily);
    Reader.setSpacing(app.prefs.spacing);
    TTS.setRate(app.prefs.rate);
    if (app.prefs.voiceURI) TTS.setVoice(app.prefs.voiceURI);
    TTS.setUseEcho(app.prefs.useEcho !== false);
    // Sync UI
    syncPrefsUI();
  }

  async function savePrefs() {
    await DB.setPref('prefs', app.prefs);
  }

  function syncPrefsUI() {
    document.querySelectorAll('[data-theme]').forEach(b => b.classList.toggle('active', b.dataset.theme === app.prefs.theme));
    // Font size segment is -1/0/+1 buttons — active reflects direction of current scale
    const fontButtons = document.querySelectorAll('[data-font]');
    fontButtons.forEach(b => b.classList.remove('active'));
    const match = Array.from(fontButtons).find(b => Number(b.dataset.font) === Math.sign(app.prefs.fontScale));
    if (match) match.classList.add('active');
    if (fontSizeLabel) fontSizeLabel.textContent = (Reader.FONT_SIZES[String(app.prefs.fontScale)] || '100%');
    document.querySelectorAll('[data-spacing]').forEach(b => b.classList.toggle('active', Number(b.dataset.spacing) === app.prefs.spacing));
    document.querySelectorAll('[data-ff]').forEach(b => b.classList.toggle('active', b.dataset.ff === app.prefs.fontFamily));
    rateEl.value = app.prefs.rate;
    rateLabel.textContent = `${Number(app.prefs.rate).toFixed(1)}×`;
  }

  // -------------------- Library --------------------
  async function renderLibrary() {
    const books = await DB.listBooks();
    bookGrid.innerHTML = '';
    if (!books.length) {
      bookGrid.innerHTML = `
        <div class="empty">
          <svg width="84" height="84" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M18 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm0 18H6V4h2v8l2.5-1.5L13 12V4h5v16z" />
          </svg>
          <p>Your library is empty.</p>
          <p class="hint">Add an EPUB, PDF, or text file to get started — your books stay on your device.</p>
        </div>`;
      return;
    }
    // One IDB read for all book states (progress + lastOpened live in the state store).
    const states = await DB.listStates();
    const withState = books.map((book) => ({ book, st: states.get(book.id) || { id: book.id, progress: 0, lastOpened: 0, bookmarks: [] } }));
    withState.sort((a, b) => (b.st.lastOpened || 0) - (a.st.lastOpened || 0));
    for (const { book, st } of withState) {
      const card = document.createElement('div');
      card.className = 'book-card';
      const title = escapeHTML(book.title);
      const author = escapeHTML(book.author || '');
      const pct = Math.round((st.progress || 0) * 100);
      card.innerHTML = `
        <div class="book-cover">${book.cover
          ? `<img alt="" src="${book.cover}">`
          : `<span>${firstChars(book.title)}</span>`}</div>
        <div class="book-meta">
          <p class="book-title">${title}</p>
          <p class="book-author">${author || formatKind(book.format)}</p>
          <div class="book-progress" title="${pct}% read"><span style="width:${pct}%"></span></div>
        </div>
        <button class="delete" aria-label="Remove">
          <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12z"/></svg>
        </button>
      `;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.delete')) return;
        openBook(book.id);
      });
      card.querySelector('.delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove "${book.title}"?`)) return;
        await DB.deleteBook(book.id);
        renderLibrary();
      });
      bookGrid.appendChild(card);
    }
  }

  function escapeHTML(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function firstChars(s) { return (s || 'Book').trim().slice(0, 1).toUpperCase(); }
  function formatKind(f) { return { epub: 'EPUB', pdf: 'PDF', txt: 'Text' }[f] || f; }

  // -------------------- Add / Upload --------------------
  function formatFromFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.epub')) return 'epub';
    if (name.endsWith('.pdf')) return 'pdf';
    if (name.endsWith('.txt')) return 'txt';
    if (name.endsWith('.mobi') || name.endsWith('.azw') || name.endsWith('.azw3')) return 'mobi';
    return null;
  }

  async function extractEpubMeta(arrayBuffer) {
    try {
      const zip = await JSZip.loadAsync(arrayBuffer);
      // Find container.xml
      const container = await zip.file('META-INF/container.xml').async('string');
      const m = container.match(/full-path="([^"]+)"/);
      if (!m) return null;
      const opfPath = m[1];
      const opf = await zip.file(opfPath).async('string');
      const title = (opf.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i) || [])[1];
      const author = (opf.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/i) || [])[1];
      // Cover image: find <meta name="cover" content="X"/> then item id=X
      let cover = null;
      const coverIdMatch = opf.match(/<meta[^>]+name="cover"[^>]+content="([^"]+)"/i);
      const coverId = coverIdMatch ? coverIdMatch[1] : null;
      let coverHref = null;
      if (coverId) {
        const itemRe = new RegExp(`<item[^>]+id="${coverId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*href="([^"]+)"`, 'i');
        const it = opf.match(itemRe);
        if (it) coverHref = it[1];
      }
      if (!coverHref) {
        // Fallback: first image item in manifest
        const imgItem = opf.match(/<item[^>]+media-type="image\/[^"]+"[^>]+href="([^"]+)"/i);
        if (imgItem) coverHref = imgItem[1];
      }
      if (coverHref) {
        const opfDir = opfPath.includes('/') ? opfPath.replace(/\/[^/]+$/, '/') : '';
        const full = resolvePath(opfDir, coverHref);
        const file = zip.file(full);
        if (file) {
          const blob = await file.async('blob');
          cover = await blobToDataURL(blob);
        }
      }
      return { title: title || null, author: author || null, cover };
    } catch (_) {
      return null;
    }
  }

  function resolvePath(base, rel) {
    if (rel.startsWith('/')) return rel.slice(1);
    const parts = (base + rel).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p && p !== '.') out.push(p);
    }
    return out.join('/');
  }

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function extractPdfMeta(arrayBuffer) {
    try {
      const doc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
      const meta = await doc.getMetadata();
      const info = meta && meta.info || {};
      let cover = null;
      try {
        const page = await doc.getPage(1);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = 240 / vp0.width;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        cover = canvas.toDataURL('image/jpeg', 0.72);
      } catch (_) {}
      await doc.destroy();
      return { title: info.Title || null, author: info.Author || null, cover };
    } catch (_) {
      return null;
    }
  }

  async function addFiles(files) {
    let added = 0, skipped = 0;
    for (const file of files) {
      const fmt = formatFromFile(file);
      if (!fmt) { skipped++; continue; }
      if (fmt === 'mobi') {
        showToast('MOBI isn\'t supported in-browser yet — convert to EPUB with Calibre, then re-add.', 4000);
        skipped++;
        continue;
      }
      const buf = await file.arrayBuffer();
      let meta = {};
      if (fmt === 'epub') meta = await extractEpubMeta(buf) || {};
      else if (fmt === 'pdf') meta = await extractPdfMeta(buf) || {};
      const id = 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const title = (meta.title || file.name.replace(/\.[^.]+$/, '')).trim();
      const author = meta.author || '';
      const cover = meta.cover || null;
      const book = {
        id,
        title,
        author,
        format: fmt,
        size: file.size,
        cover,
        data: buf,
        addedAt: Date.now(),
        lastOpened: null,
      };
      try {
        await DB.addBook(book);
        added++;
      } catch (e) {
        console.error(e);
        showToast('Failed to save "' + file.name + '" — storage full?');
      }
    }
    if (added) showToast(`Added ${added} book${added === 1 ? '' : 's'}.`);
    else if (skipped && !added) showToast('No supported files were added.');
    renderLibrary();
  }

  // Drag and drop — counter trick so moving between child elements doesn't flicker
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    dropZone.classList.add('hover');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropZone.classList.remove('hover');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove('hover');
    const files = Array.from(e.dataTransfer && e.dataTransfer.files || []);
    if (files.length) addFiles(files);
  });
  dropZone.addEventListener('click', () => fileInput.click());
  addBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    if (files.length) addFiles(files);
    fileInput.value = '';
  });

  // -------------------- Reader open/close --------------------
  async function openBook(id) {
    const book = await DB.getBook(id);
    if (!book) { showToast('Book not found.'); return; }
    app.currentBookId = id;
    app.currentState = await DB.getState(id);
    readerTitle.textContent = book.title;
    libraryView.classList.remove('active');
    readerView.classList.add('active');
    loading.classList.remove('hidden');
    Reader.onReady(() => { loading.classList.add('hidden'); });
    Reader.onProgressChange(async (info) => {
      const p = info.progress || 0;
      progressEl.value = String(Math.round(p * 1000) / 10);
      progressLabel.textContent = `${Math.round(p * 100)}%`;
      schedulePersist({ position: Reader.currentPosition(), progress: p });
    });
    try {
      await Reader.load(book);
      const st = await DB.getState(id);
      st.lastOpened = Date.now();
      await DB.setState(st);
      app.currentState = st;
    } catch (e) {
      console.error(e);
      showToast('Couldn\'t open this book — the file may be corrupt.');
      closeReader();
    }
  }

  function schedulePersist(patch) {
    if (!app.currentBookId) return;
    clearTimeout(app.savingTimer);
    app.savingTimer = setTimeout(async () => {
      app.savingTimer = null;
      const st = await DB.getState(app.currentBookId);
      Object.assign(st, patch);
      await DB.setState(st);
      app.currentState = st;
    }, 400);
  }

  async function closeReader() {
    // Flush any pending position-save BEFORE destroying the reader, so we don't
    // persist a null position on top of a good one.
    if (app.savingTimer) {
      clearTimeout(app.savingTimer);
      app.savingTimer = null;
      if (app.currentBookId) {
        const st = await DB.getState(app.currentBookId);
        const pos = Reader.currentPosition();
        if (pos) st.position = pos;
        await DB.setState(st);
      }
    }
    if (TTS.isPlaying()) TTS.stop();
    Reader.destroy();
    app.currentBookId = null;
    app.currentState = null;
    readerView.classList.remove('active');
    libraryView.classList.add('active');
    closeAllDrawers();
    setTtsUI(false);
    renderLibrary();
  }

  backBtn.addEventListener('click', closeReader);
  prevBtn.addEventListener('click', () => Reader.prev());
  nextBtn.addEventListener('click', () => Reader.next());
  progressEl.addEventListener('change', () => Reader.goto(Number(progressEl.value) / 100));

  // Tap-zone + swipe page turning for PDF / TXT.
  // (EPUB has its own handlers wired inside the rendered iframe — those still
  // win because touches inside the iframe don't bubble out here.)
  wireReaderGestures();

  function wireReaderGestures() {
    const area = document.getElementById('reader-content');
    if (!area || !window.PointerEvent) return;
    let downX = 0, downY = 0, downT = 0, tracking = false;

    const isInteractive = (el) =>
      el && el.closest && el.closest('button, input, select, textarea, a, [role="button"], .drawer, #scrim');

    area.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (isInteractive(e.target)) { tracking = false; return; }
      tracking = true;
      downX = e.clientX; downY = e.clientY; downT = Date.now();
    });

    area.addEventListener('pointerup', (e) => {
      if (!tracking) return;
      tracking = false;
      if (isInteractive(e.target)) return;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      const dt = Date.now() - downT;

      // Horizontal swipe — must be predominantly sideways so vertical TXT
      // scrolling isn't misread as a page turn.
      if (dt < 600 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) Reader.next(); else Reader.prev();
        return;
      }
      // Tap — left third = back, right third = forward, middle does nothing.
      if (dt < 350 && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
        const rect = area.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const w = rect.width;
        if (x < w * 0.30) Reader.prev();
        else if (x > w * 0.70) Reader.next();
      }
    });

    // If the pointer leaves or is cancelled, drop tracking so we don't fire spuriously.
    area.addEventListener('pointercancel', () => { tracking = false; });
  }

  // Keyboard shortcuts when reader active
  window.addEventListener('keydown', (e) => {
    if (!readerView.classList.contains('active')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); Reader.next(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); Reader.prev(); }
    else if (e.key === 'Escape') closeReader();
  });

  // -------------------- Drawers --------------------
  function openDrawer(drawer) {
    closeAllDrawers(drawer);
    drawer.classList.add('open');
    scrim.classList.remove('hidden');
  }
  function closeAllDrawers(except) {
    for (const d of [tocDrawer, settingsDrawer, readerSettingsDrawer]) {
      if (d === except) continue;
      d.classList.remove('open');
    }
    if (![tocDrawer, settingsDrawer, readerSettingsDrawer].some(d => d.classList.contains('open'))) {
      scrim.classList.add('hidden');
    }
  }
  scrim.addEventListener('click', () => closeAllDrawers());
  document.querySelectorAll('.close-drawer').forEach((b) => b.addEventListener('click', () => closeAllDrawers()));

  // TOC / Bookmarks
  tocBtn.addEventListener('click', async () => {
    openDrawer(tocDrawer);
    const items = await Reader.toc();
    renderToc(items);
    renderBookmarks();
  });

  function renderToc(items) {
    tocList.innerHTML = '';
    if (!items.length) {
      tocList.innerHTML = '<div class="empty-line">No contents available.</div>';
      return;
    }
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'item depth-' + Math.min(3, it.depth || 0);
      row.innerHTML = `<div class="label">${escapeHTML(it.label || 'Untitled')}</div>`;
      row.addEventListener('click', async () => {
        await Reader.gotoTocItem(it);
        closeAllDrawers();
      });
      tocList.appendChild(row);
    }
  }

  function renderBookmarks() {
    bookmarksList.innerHTML = '';
    const bms = (app.currentState && app.currentState.bookmarks) || [];
    if (!bms.length) {
      bookmarksList.innerHTML = '<div class="empty-line">No bookmarks yet. Tap the bookmark icon on any page to save one.</div>';
      return;
    }
    for (const bm of bms.slice().reverse()) {
      const row = document.createElement('div');
      row.className = 'item';
      const when = new Date(bm.at).toLocaleString();
      row.innerHTML = `
        <div>
          <div class="label">${escapeHTML(bm.label || 'Bookmark')}</div>
          <div class="sub">${Math.round((bm.progress || 0) * 100)}% · ${escapeHTML(when)}</div>
        </div>
        <button class="kill" aria-label="Remove">✕</button>
      `;
      row.addEventListener('click', async (e) => {
        if (e.target.closest('.kill')) return;
        if (bm.position) await Reader.goto(bm.position);
        closeAllDrawers();
      });
      row.querySelector('.kill').addEventListener('click', async (e) => {
        e.stopPropagation();
        app.currentState.bookmarks = app.currentState.bookmarks.filter(x => x.id !== bm.id);
        await DB.setState(app.currentState);
        renderBookmarks();
      });
      bookmarksList.appendChild(row);
    }
  }

  document.querySelectorAll('.drawer-tabs .tab').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.drawer-tabs .tab').forEach(x => x.classList.toggle('active', x === b));
      if (b.dataset.tab === 'toc') { tocList.classList.remove('hidden'); bookmarksList.classList.add('hidden'); }
      else { tocList.classList.add('hidden'); bookmarksList.classList.remove('hidden'); }
    });
  });

  bookmarkBtn.addEventListener('click', async () => {
    if (!app.currentBookId) return;
    const st = await DB.getState(app.currentBookId);
    st.bookmarks = st.bookmarks || [];
    const pos = Reader.currentPosition();
    const sliderPct = Number(progressEl.value) / 100;
    const progress = sliderPct > 0 ? sliderPct : (st.progress || 0);
    const id = 'bm_' + Date.now().toString(36);
    st.bookmarks.push({ id, position: pos, progress, at: Date.now(), label: 'Bookmark' });
    await DB.setState(st);
    app.currentState = st;
    showToast('Bookmarked.');
  });

  // -------------------- Settings --------------------
  settingsBtn.addEventListener('click', async () => {
    openDrawer(settingsDrawer);
    await populateVoices();
    const u = await DB.usage();
    if (u.quota) storageInfo.textContent = `${formatBytes(u.usage)} used of ${formatBytes(u.quota)} available`;
    else storageInfo.textContent = `${formatBytes(u.usage)} used`;
  });
  readerSettingsBtn.addEventListener('click', () => openDrawer(readerSettingsDrawer));

  function formatBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n > 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
  }

  async function populateVoices() {
    const voices = TTS.voices;
    voiceSelect.innerHTML = '';
    if (!voices.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(system voices loading — pick after opening a book)';
      voiceSelect.appendChild(o);
      return;
    }
    const groups = {};
    for (const v of voices) {
      (groups[v.lang] = groups[v.lang] || []).push(v);
    }
    // Prefer English first
    const langs = Object.keys(groups).sort((a, b) => {
      const ae = /^en/i.test(a) ? 0 : 1;
      const be = /^en/i.test(b) ? 0 : 1;
      return ae - be || a.localeCompare(b);
    });
    for (const lang of langs) {
      const g = document.createElement('optgroup');
      g.label = lang;
      for (const v of groups[lang]) {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = v.name + (v.default ? ' — default' : '');
        if (app.prefs.voiceURI === v.voiceURI) o.selected = true;
        g.appendChild(o);
      }
      voiceSelect.appendChild(g);
    }
  }

  voiceSelect.addEventListener('change', () => {
    app.prefs.voiceURI = voiceSelect.value;
    TTS.setVoice(voiceSelect.value);
    savePrefs();
  });
  if (useEchoToggle) {
    useEchoToggle.checked = app.prefs.useEcho !== false;
    useEchoToggle.addEventListener('change', () => {
      app.prefs.useEcho = useEchoToggle.checked;
      TTS.setUseEcho(app.prefs.useEcho);
      // If currently playing, stop so the next play uses the new engine.
      if (TTS.isPlaying()) { TTS.stop(); setTtsUI(false); }
      savePrefs();
    });
  }
  if (window.speechSynthesis) {
    speechSynthesis.addEventListener('voiceschanged', () => {
      if (settingsDrawer.classList.contains('open')) populateVoices();
    });
  }
  rateEl.addEventListener('input', () => {
    app.prefs.rate = Number(rateEl.value);
    rateLabel.textContent = `${app.prefs.rate.toFixed(1)}×`;
    TTS.setRate(app.prefs.rate);
    savePrefs();
  });

  // Reader settings: theme / font / spacing / family
  document.querySelectorAll('[data-theme]').forEach(b => b.addEventListener('click', () => {
    app.prefs.theme = b.dataset.theme;
    Reader.setTheme(app.prefs.theme);
    document.querySelectorAll('[data-theme]').forEach(x => x.classList.toggle('active', x === b));
    savePrefs();
  }));
  document.querySelectorAll('[data-font]').forEach(b => b.addEventListener('click', () => {
    const dir = Number(b.dataset.font);
    if (dir === 0) app.prefs.fontScale = 0;
    else app.prefs.fontScale = Math.max(-2, Math.min(4, app.prefs.fontScale + dir));
    Reader.setFontScale(app.prefs.fontScale);
    if (fontSizeLabel) fontSizeLabel.textContent = Reader.FONT_SIZES[String(app.prefs.fontScale)] || '100%';
    savePrefs();
  }));
  document.querySelectorAll('[data-spacing]').forEach(b => b.addEventListener('click', () => {
    app.prefs.spacing = Number(b.dataset.spacing);
    Reader.setSpacing(app.prefs.spacing);
    document.querySelectorAll('[data-spacing]').forEach(x => x.classList.toggle('active', x === b));
    savePrefs();
  }));
  document.querySelectorAll('[data-ff]').forEach(b => b.addEventListener('click', () => {
    app.prefs.fontFamily = b.dataset.ff;
    Reader.setFontFamily(app.prefs.fontFamily);
    document.querySelectorAll('[data-ff]').forEach(x => x.classList.toggle('active', x === b));
    savePrefs();
  }));

  // -------------------- TTS --------------------
  ttsBtn.addEventListener('click', async () => {
    if (!app.currentBookId) return;
    if (TTS.isPlaying()) {
      TTS.stop();
      setTtsUI(false);
      return;
    }
    const text = await Reader.getCurrentText();
    if (!text || !text.trim()) {
      showToast('No readable text on this page.');
      return;
    }
    setTtsUI(true);
    TTS.play(text, {
      onStop: () => setTtsUI(false),
      onChunkEnd: async (i) => {
        // When we finish the last chunk, auto-advance to the next page and keep reading
        if (i >= 0 && !TTS.isPlaying()) return;
      },
    });
    // Auto-advance: when TTS finishes the whole page, turn the page and keep going
    watchTtsForAdvance();
  });

  function watchTtsForAdvance() {
    // Clear any prior watcher so we never stack intervals (which would make
    // Reader.next() fire multiple times per page boundary and skip pages).
    if (app.ttsWatchTimer) clearInterval(app.ttsWatchTimer);
    app.ttsWatchTimer = setInterval(async () => {
      if (!app.ttsActive) {
        clearInterval(app.ttsWatchTimer);
        app.ttsWatchTimer = null;
        return;
      }
      if (!TTS.isPlaying()) {
        clearInterval(app.ttsWatchTimer);
        app.ttsWatchTimer = null;
        const beforePos = JSON.stringify(Reader.currentPosition());
        Reader.next();
        setTimeout(async () => {
          if (!app.ttsActive) return;
          const afterPos = JSON.stringify(Reader.currentPosition());
          if (beforePos === afterPos) {
            setTtsUI(false);
            showToast('Finished.');
            return;
          }
          const text = await Reader.getCurrentText();
          if (text && text.trim() && app.ttsActive) {
            TTS.play(text, { onStop: () => setTtsUI(false) });
            watchTtsForAdvance();
          } else {
            setTtsUI(false);
          }
        }, 500);
      }
    }, 600);
  }

  function setTtsUI(on) {
    app.ttsActive = on;
    readerView.classList.toggle('tts-active', on);
    if (ttsBtn) {
      ttsBtn.classList.toggle('is-playing', on);
      ttsBtn.setAttribute('aria-label', on ? 'Stop reading' : 'Read aloud');
    }
    if (!on && app.ttsWatchTimer) {
      clearInterval(app.ttsWatchTimer);
      app.ttsWatchTimer = null;
    }
  }

  // Toggle chrome on tap middle (emitted by EPUB engine) — kept simple: always visible
  window.addEventListener('reader:toggle-chrome', () => {});

  // -------------------- Init --------------------
  (async function init() {
    await loadPrefs();
    await renderLibrary();
    // Ask for persistent storage so books don't get evicted.
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (_) {}
    }
  })();
})();

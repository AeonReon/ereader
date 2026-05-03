// Reader engine abstraction. One interface, three backends (EPUB, PDF, TXT).
// Each backend provides: load, render, next, prev, goto(progress|cfi|page), toc, getCurrentText (for TTS).
const Reader = (() => {
  const state = {
    kind: null,          // 'epub' | 'pdf' | 'txt'
    book: null,          // book record (id, title, author, format, data)
    epub: { book: null, rendition: null, locations: null },
    pdf: {
      doc: null, page: 1, pages: 1, rendering: false,
      cache: new Map(),       // pageNum → { bitmap, maxW, dpr } — LRU
      prerendering: new Set(),// pages currently being prerendered
      maxCache: 4,            // current + N±1 + 1 spare; modest for BOOX
    },
    txt: { text: '', pos: 0 },
    theme: 'dark',
    fontScale: 0,        // -2..+4
    fontFamily: 'serif',
    spacing: 1.6,
    onProgress: null,    // (progress 0..1)
    onLocationChange: null,
    onReady: null,
  };

  const FONT_SIZES = { '-2': '80%', '-1': '90%', '0': '100%', '1': '115%', '2': '130%', '3': '150%', '4': '175%' };
  const FONT_FAMILIES = {
    serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    mono: 'SFMono-Regular, Menlo, Consolas, monospace',
  };
  const THEME_COLORS = {
    light: { bg: '#f5efe0', fg: '#1b1b1b' },
    sepia: { bg: '#f0e4ca', fg: '#3b2a1a' },
    dark:  { bg: '#0f1a2c', fg: '#e8ecf4' },
  };

  function setActiveArea(kind) {
    for (const el of document.querySelectorAll('.reader-area')) el.classList.remove('active');
    if (kind === 'epub') document.getElementById('epub-area').classList.add('active');
    else if (kind === 'pdf') document.getElementById('pdf-area').classList.add('active');
    else if (kind === 'txt') document.getElementById('txt-area').classList.add('active');
  }

  function applyThemeToRoot() {
    const root = document.getElementById('reader');
    root.classList.remove('theme-light', 'theme-sepia', 'theme-dark');
    root.classList.add('theme-' + state.theme);
  }

  async function load(book) {
    state.book = book;
    state.kind = book.format;
    setActiveArea(state.kind);
    applyThemeToRoot();
    if (state.kind === 'epub') return loadEpub(book);
    if (state.kind === 'pdf') return loadPdf(book);
    if (state.kind === 'txt') return loadTxt(book);
    throw new Error('Unsupported format: ' + state.kind);
  }

  // -------------------- EPUB --------------------
  async function loadEpub(book) {
    const area = document.getElementById('epub-area');
    area.innerHTML = '';
    const buf = book.data instanceof ArrayBuffer ? book.data.slice(0) : book.data;
    const b = ePub(buf);
    state.epub.book = b;
    const rendition = b.renderTo(area, {
      width: '100%', height: '100%',
      flow: 'paginated', manager: 'default', spread: 'none',
      allowScriptedContent: false,
    });
    state.epub.rendition = rendition;

    applyEpubStyles();

    // Swipe/tap handlers on epub area
    wireEpubGestures(rendition, area);

    const state0 = await DB.getState(book.id);
    if (state0.position) {
      try { await rendition.display(state0.position); }
      catch (_) { await rendition.display(); }
    } else {
      await rendition.display();
    }

    // Build locations for progress (async, ~1000 chars per loc).
    b.ready.then(async () => {
      try {
        await b.locations.generate(1200);
        state.epub.locations = b.locations;
      } catch (_) {}
    });

    rendition.on('relocated', (loc) => {
      const cfi = loc && loc.start && loc.start.cfi;
      let progress = 0;
      if (state.epub.locations && cfi) {
        progress = b.locations.percentageFromCfi(cfi) || 0;
      }
      if (state.onLocationChange) state.onLocationChange({ cfi, progress });
    });

    if (state.onReady) state.onReady();
  }

  function wireEpubGestures(rendition, area) {
    // Tap edges to page turn; middle shows/hides chrome (handled by app via event).
    rendition.hooks.content.register((contents) => {
      const doc = contents.document;
      if (!doc) return;
      let downX = 0, downY = 0, downT = 0;
      doc.addEventListener('touchstart', (e) => {
        const t = e.touches[0]; downX = t.clientX; downY = t.clientY; downT = Date.now();
      }, { passive: true });
      doc.addEventListener('touchend', (e) => {
        const t = e.changedTouches[0]; const dx = t.clientX - downX; const dy = t.clientY - downY;
        const dt = Date.now() - downT;
        if (dt < 400 && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
          if (dx < 0) rendition.next(); else rendition.prev();
        } else if (dt < 300 && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
          // tap
          const w = doc.documentElement.clientWidth;
          if (t.clientX < w * 0.3) rendition.prev();
          else if (t.clientX > w * 0.7) rendition.next();
          else window.dispatchEvent(new CustomEvent('reader:toggle-chrome'));
        }
      }, { passive: true });
      doc.addEventListener('click', (e) => {
        const w = doc.documentElement.clientWidth;
        if (e.clientX < w * 0.3) rendition.prev();
        else if (e.clientX > w * 0.7) rendition.next();
        else window.dispatchEvent(new CustomEvent('reader:toggle-chrome'));
      });
      doc.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') rendition.next();
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') rendition.prev();
      });
    });
  }

  function applyEpubStyles() {
    if (!state.epub.rendition) return;
    const colors = THEME_COLORS[state.theme];
    const size = FONT_SIZES[String(state.fontScale)] || '100%';
    const ff = FONT_FAMILIES[state.fontFamily];
    state.epub.rendition.themes.default({
      'html, body': {
        'background': colors.bg + ' !important',
        'color': colors.fg + ' !important',
        'font-family': ff + ' !important',
        'line-height': String(state.spacing) + ' !important',
      },
      'body': {
        'padding': '16px 20px !important',
      },
      'p, li, blockquote': {
        'line-height': String(state.spacing) + ' !important',
      },
      'a': { 'color': '#d4a952 !important' },
      '::selection': { 'background': 'rgba(212,169,82,0.4)' },
      '*': { 'max-width': '100% !important' },
      'img': { 'max-width': '100% !important', 'height': 'auto !important' },
    });
    state.epub.rendition.themes.fontSize(size);
  }

  // -------------------- PDF --------------------
  async function loadPdf(book) {
    // pdf.js transfers the buffer to its worker, which detaches the original.
    // Slice so the book record in memory stays intact (and can be reopened).
    const buf = book.data instanceof ArrayBuffer ? book.data.slice(0) : book.data;
    const task = pdfjsLib.getDocument({ data: buf });
    const doc = await task.promise;
    state.pdf.doc = doc;
    state.pdf.pages = doc.numPages;
    const state0 = await DB.getState(book.id);
    state.pdf.page = (state0.position && state0.position.page) || 1;
    await renderPdf();
    if (state.onReady) state.onReady();
  }

  // Render a single PDF page off-screen and return an ImageBitmap (or the
  // canvas itself on browsers that lack createImageBitmap).
  async function renderPdfPageToBitmap(pageNum, maxW, dpr) {
    const page = await state.pdf.doc.getPage(pageNum);
    const viewport0 = page.getViewport({ scale: 1 });
    const scale = maxW / viewport0.width;
    const viewport = page.getViewport({ scale: scale * dpr });
    const off = document.createElement('canvas');
    off.width = viewport.width;
    off.height = viewport.height;
    const offCtx = off.getContext('2d', { alpha: false });
    await page.render({ canvasContext: offCtx, viewport }).promise;
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(off); } catch (_) { return off; }
    }
    return off;
  }

  function drawPdfBitmap(bitmap, dpr) {
    const canvas = document.getElementById('pdf-canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.style.width = (bitmap.width / dpr) + 'px';
    canvas.style.height = (bitmap.height / dpr) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(bitmap, 0, 0);
  }

  function pdfCacheTouch(pageNum) {
    // Re-insert at end → marks as most-recently-used in Map insertion order.
    const v = state.pdf.cache.get(pageNum);
    if (v) { state.pdf.cache.delete(pageNum); state.pdf.cache.set(pageNum, v); }
  }

  function pdfCacheEvict() {
    while (state.pdf.cache.size > state.pdf.maxCache) {
      const oldest = state.pdf.cache.keys().next().value;
      const v = state.pdf.cache.get(oldest);
      try { if (v && v.bitmap && v.bitmap.close) v.bitmap.close(); } catch (_) {}
      state.pdf.cache.delete(oldest);
    }
  }

  function pdfClearCache() {
    for (const v of state.pdf.cache.values()) {
      try { if (v && v.bitmap && v.bitmap.close) v.bitmap.close(); } catch (_) {}
    }
    state.pdf.cache.clear();
    state.pdf.prerendering.clear();
  }

  function schedulePdfPrerender(pageNum) {
    if (!state.pdf.doc) return;
    if (pageNum < 1 || pageNum > state.pdf.pages) return;
    if (state.pdf.cache.has(pageNum) || state.pdf.prerendering.has(pageNum)) return;
    state.pdf.prerendering.add(pageNum);

    const run = async () => {
      try {
        // Bail if the user navigated away to a different format
        if (state.kind !== 'pdf' || !state.pdf.doc) return;
        const area = document.getElementById('pdf-area');
        if (!area) return;
        const maxW = Math.max(320, area.clientWidth - 16);
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const bitmap = await renderPdfPageToBitmap(pageNum, maxW, dpr);
        if (state.kind !== 'pdf' || !state.pdf.doc) return;
        state.pdf.cache.set(pageNum, { bitmap, maxW, dpr });
        pdfCacheEvict();
      } catch (_) {
        // Background failure is fine — main render path will redo it.
      } finally {
        state.pdf.prerendering.delete(pageNum);
      }
    };

    // Use idle time on capable browsers; fall back to setTimeout on the BOOX
    // and other older Chromium builds that don't ship requestIdleCallback.
    if (window.requestIdleCallback) {
      requestIdleCallback(run, { timeout: 1500 });
    } else {
      setTimeout(run, 80);
    }
  }

  async function renderPdf() {
    if (!state.pdf.doc) return;
    const pageNum = state.pdf.page;
    const area = document.getElementById('pdf-area');
    const maxW = Math.max(320, area.clientWidth - 16);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    // Cache hit → blit instantly. This is the swipe-feels-magical path.
    const cached = state.pdf.cache.get(pageNum);
    if (cached && cached.maxW === maxW && cached.dpr === dpr) {
      drawPdfBitmap(cached.bitmap, dpr);
      pdfCacheTouch(pageNum);
      const progress = state.pdf.pages ? (pageNum - 1) / state.pdf.pages : 0;
      if (state.onLocationChange) state.onLocationChange({ page: pageNum, progress });
      // Keep the buffer ahead of the user
      schedulePdfPrerender(pageNum + 1);
      schedulePdfPrerender(pageNum - 1);
      return;
    }

    // Viewport changed (resize / rotation) — old bitmaps are at the wrong size.
    if (cached) pdfClearCache();

    if (state.pdf.rendering) return;
    state.pdf.rendering = true;
    try {
      const bitmap = await renderPdfPageToBitmap(pageNum, maxW, dpr);
      drawPdfBitmap(bitmap, dpr);
      state.pdf.cache.set(pageNum, { bitmap, maxW, dpr });
      pdfCacheEvict();
    } finally {
      state.pdf.rendering = false;
    }
    const progress = state.pdf.pages ? (pageNum - 1) / state.pdf.pages : 0;
    if (state.onLocationChange) state.onLocationChange({ page: pageNum, progress });

    // Pre-fetch the neighbours during idle time for instant swipe.
    schedulePdfPrerender(pageNum + 1);
    schedulePdfPrerender(pageNum - 1);
  }

  // -------------------- TXT --------------------
  async function loadTxt(book) {
    let text = '';
    if (typeof book.data === 'string') text = book.data;
    else if (book.data instanceof ArrayBuffer) text = new TextDecoder('utf-8').decode(new Uint8Array(book.data));
    else if (book.data instanceof Uint8Array) text = new TextDecoder('utf-8').decode(book.data);
    state.txt.text = text;
    const body = document.getElementById('txt-body');
    body.style.fontFamily = FONT_FAMILIES[state.fontFamily];
    body.style.lineHeight = String(state.spacing);
    body.style.fontSize = FONT_SIZES[String(state.fontScale)];
    // For very large files, setting textContent can jank the thread. Chunk it.
    if (text.length > 200000) {
      body.textContent = '';
      const LIMIT = 100000;
      let offset = 0;
      const pump = () => {
        body.appendChild(document.createTextNode(text.slice(offset, offset + LIMIT)));
        offset += LIMIT;
        if (offset < text.length) requestAnimationFrame(pump);
      };
      pump();
    } else {
      body.textContent = text;
    }

    const area = document.getElementById('txt-area');
    const state0 = await DB.getState(book.id);
    if (state0.position && state0.position.scroll) {
      requestAnimationFrame(() => { area.scrollTop = state0.position.scroll; });
    }
    area.onscroll = () => {
      const max = area.scrollHeight - area.clientHeight;
      const progress = max > 0 ? area.scrollTop / max : 0;
      if (state.onLocationChange) state.onLocationChange({ scroll: area.scrollTop, progress });
    };
    if (state.onReady) state.onReady();
  }

  // -------------------- Public API --------------------
  function next() {
    if (state.kind === 'epub') state.epub.rendition && state.epub.rendition.next();
    else if (state.kind === 'pdf') { if (state.pdf.page < state.pdf.pages) { state.pdf.page++; renderPdf(); } }
    else if (state.kind === 'txt') {
      const a = document.getElementById('txt-area');
      a.scrollBy({ top: a.clientHeight - 40, behavior: 'smooth' });
    }
  }

  function prev() {
    if (state.kind === 'epub') state.epub.rendition && state.epub.rendition.prev();
    else if (state.kind === 'pdf') { if (state.pdf.page > 1) { state.pdf.page--; renderPdf(); } }
    else if (state.kind === 'txt') {
      const a = document.getElementById('txt-area');
      a.scrollBy({ top: -(a.clientHeight - 40), behavior: 'smooth' });
    }
  }

  async function goto(target) {
    if (state.kind === 'epub' && state.epub.rendition) {
      if (typeof target === 'number') {
        if (state.epub.locations) {
          const cfi = state.epub.locations.cfiFromPercentage(target);
          if (cfi) await state.epub.rendition.display(cfi);
        }
      } else {
        await state.epub.rendition.display(target);
      }
    } else if (state.kind === 'pdf') {
      if (typeof target === 'number') {
        state.pdf.page = Math.max(1, Math.min(state.pdf.pages, Math.round(1 + target * (state.pdf.pages - 1))));
      } else if (typeof target === 'object' && target.page) {
        state.pdf.page = target.page;
      }
      await renderPdf();
    } else if (state.kind === 'txt') {
      const a = document.getElementById('txt-area');
      const max = a.scrollHeight - a.clientHeight;
      a.scrollTop = Math.max(0, Math.min(max, max * (typeof target === 'number' ? target : 0)));
    }
  }

  async function toc() {
    if (state.kind === 'epub' && state.epub.book) {
      const nav = await state.epub.book.loaded.navigation;
      const out = [];
      const walk = (items, depth) => {
        for (const it of items) {
          out.push({ label: it.label.trim(), href: it.href, depth });
          if (it.subitems && it.subitems.length) walk(it.subitems, depth + 1);
        }
      };
      walk(nav.toc || [], 0);
      return out;
    }
    if (state.kind === 'pdf' && state.pdf.doc) {
      const outline = await state.pdf.doc.getOutline();
      const out = [];
      const walk = async (items, depth) => {
        if (!items) return;
        for (const it of items) {
          let page = null;
          try {
            let dest = it.dest;
            if (typeof dest === 'string') dest = await state.pdf.doc.getDestination(dest);
            if (dest && dest[0]) {
              const idx = await state.pdf.doc.getPageIndex(dest[0]);
              page = idx + 1;
            }
          } catch (_) {}
          out.push({ label: it.title, page, depth });
          if (it.items && it.items.length) await walk(it.items, depth + 1);
        }
      };
      await walk(outline, 0);
      if (!out.length) {
        // Fallback: list pages
        for (let i = 1; i <= Math.min(state.pdf.pages, 50); i++) {
          out.push({ label: `Page ${i}`, page: i, depth: 0 });
        }
      }
      return out;
    }
    return [];
  }

  async function gotoTocItem(item) {
    if (state.kind === 'epub' && item.href) await state.epub.rendition.display(item.href);
    else if (state.kind === 'pdf' && item.page) { state.pdf.page = item.page; await renderPdf(); }
  }

  function currentPosition() {
    if (state.kind === 'epub') {
      const cur = state.epub.rendition && state.epub.rendition.currentLocation();
      return cur && cur.start ? cur.start.cfi : null;
    }
    if (state.kind === 'pdf') return { page: state.pdf.page };
    if (state.kind === 'txt') {
      const a = document.getElementById('txt-area');
      return { scroll: a ? a.scrollTop : 0 };
    }
    return null;
  }

  async function getCurrentText() {
    const lines = await getCurrentLines();
    return lines.join(' ');
  }

  // Line-aware text extraction. The TTS pipeline uses this to detect and
  // strip repeated header / footer lines (chapter title at top of every
  // page, page numbers at the bottom) without altering the visible page.
  // PDF-only: returns array of { text, h } where h is the text item height
  // (rough font size in PDF units). Lets the TTS skip filter detect header
  // and footer lines by their typographic size — much more reliable than
  // matching repeated text, which fails when chapter titles change content
  // between chapters but stay the same SIZE the whole way through.
  async function getCurrentLinesMeta() {
    if (state.kind !== 'pdf' || !state.pdf.doc) return [];
    const page = await state.pdf.doc.getPage(state.pdf.page);
    const tc = await page.getTextContent();
    // Group items into lines by y-coordinate. PDF text items have a
    // transform matrix [a,b,c,d,e,f] where (e,f) is the position;
    // f is the baseline y. Round to 2 units to absorb micro-jitter.
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round((it.transform ? it.transform[5] : 0) / 2) * 2;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(it);
    }
    const sortedKeys = Array.from(rows.keys()).sort((a, b) => b - a);
    const lines = [];
    for (const y of sortedKeys) {
      const row = rows.get(y).sort((a, b) =>
        (a.transform ? a.transform[4] : 0) - (b.transform ? b.transform[4] : 0));
      const text = row.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // Average height across the row, weighted by item width so a stray
      // small punctuation glyph doesn't drag the row's apparent size down.
      let totalH = 0, totalW = 0;
      for (const it of row) {
        const w = Math.max(1, it.width || 1);
        totalH += (it.height || 0) * w;
        totalW += w;
      }
      const h = totalW > 0 ? totalH / totalW : 0;
      lines.push({ text, h });
    }
    return lines;
  }

  async function getCurrentLines() {
    if (state.kind === 'epub' && state.epub.rendition) {
      const contents = state.epub.rendition.getContents();
      if (!contents || !contents.length) return [];
      const doc = contents[0].document;
      if (!doc) return [];
      const raw = doc.body.innerText || doc.body.textContent || '';
      return raw.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
    }
    if (state.kind === 'pdf' && state.pdf.doc) {
      const meta = await getCurrentLinesMeta();
      return meta.map(m => m.text);
    }
    if (state.kind === 'txt') {
      const a = document.getElementById('txt-area');
      const body = document.getElementById('txt-body');
      if (!a || !body) return state.txt.text.split(/\r?\n+/).filter(Boolean);
      const per = Math.ceil(state.txt.text.length * (a.clientHeight / Math.max(1, a.scrollHeight)));
      const start = Math.floor(state.txt.text.length * (a.scrollTop / Math.max(1, a.scrollHeight)));
      return state.txt.text.slice(start, start + per * 3).split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
    }
    return [];
  }

  function setTheme(theme) {
    state.theme = theme;
    applyThemeToRoot();
    if (state.kind === 'epub') applyEpubStyles();
  }

  function setFontScale(s) {
    state.fontScale = Math.max(-2, Math.min(4, s));
    if (state.kind === 'epub') applyEpubStyles();
    else if (state.kind === 'txt') {
      document.getElementById('txt-body').style.fontSize = FONT_SIZES[String(state.fontScale)];
    }
  }

  function setFontFamily(ff) {
    state.fontFamily = ff;
    if (state.kind === 'epub') applyEpubStyles();
    else if (state.kind === 'txt') {
      document.getElementById('txt-body').style.fontFamily = FONT_FAMILIES[ff];
    }
  }

  function setSpacing(sp) {
    state.spacing = sp;
    if (state.kind === 'epub') applyEpubStyles();
    else if (state.kind === 'txt') {
      document.getElementById('txt-body').style.lineHeight = String(sp);
    }
  }

  function destroy() {
    if (state.epub.rendition) { try { state.epub.rendition.destroy(); } catch (_) {} }
    if (state.epub.book) { try { state.epub.book.destroy(); } catch (_) {} }
    state.epub = { book: null, rendition: null, locations: null };
    if (state.pdf.doc) { try { state.pdf.doc.destroy(); } catch (_) {} }
    pdfClearCache();
    state.pdf = {
      doc: null, page: 1, pages: 1, rendering: false,
      cache: new Map(), prerendering: new Set(), maxCache: 4,
    };
    state.txt = { text: '', pos: 0 };
    state.kind = null;
    state.book = null;
  }

  function onResize() {
    if (state.kind === 'pdf') {
      pdfClearCache();   // bitmaps are sized for the old viewport
      renderPdf();
    }
  }

  window.addEventListener('resize', onResize);

  return {
    load, next, prev, goto, toc, gotoTocItem,
    currentPosition, getCurrentText, getCurrentLines, getCurrentLinesMeta,
    setTheme, setFontScale, setFontFamily, setSpacing,
    destroy,
    onProgressChange(cb) { state.onLocationChange = cb; },
    onReady(cb) { state.onReady = cb; },
    get state() { return state; },
    FONT_SIZES,
  };
})();

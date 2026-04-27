// Read-aloud engine.
//
// Two engines, one API:
//   - "echo"  → Kokoro neural TTS via the Mac mini (https://tts.aiprofits.cc).
//               Same Echo voice used in PDF Studio and the AI chat. Sounds great.
//   - "web"   → the browser's built-in SpeechSynthesis (works offline, sounds robotic on iOS).
//
// Echo is the default. If a fetch fails (Mac mini sleeping, no internet) we silently
// fall back to "web" mid-stream so playback never just dies.
//
// Gapless playback: two persistent <audio> elements ping-pong. While element A
// plays chunk N, we fetch and pre-load chunk N+1 into element B (preload='auto'
// = browser starts decoding it). When A's `ended` fires we immediately call
// B.play() — the audio is already buffered so there's no load gap and no click.
//
// Stopping is robust: aborts in-flight fetches, pauses both audio elements,
// cancels any queued speech utterances, clears state.
const TTS = (() => {
  const ECHO_ENDPOINT = 'https://tts.aiprofits.cc/api/tts';
  const ECHO_VOICE = 'am_echo';
  const CHUNK_MAX = 280;

  const state = {
    rate: 1.0,
    voiceURI: null,        // Web Speech voice URI (used only when Echo is off)
    useEcho: true,
    engine: 'echo',        // active engine for current playback ('echo' | 'web')
    playing: false,
    paused: false,
    chunks: [],
    cursor: 0,             // index of the chunk currently playing
    onChunkStart: null,
    onChunkEnd: null,
    onStop: null,
    // Web Speech
    voices: [],
    currentUtterance: null,
    // Echo — two ping-pong audio elements + matching prefetch slots
    audios: null,          // [HTMLAudioElement, HTMLAudioElement]
    activeIdx: 0,          // which audio is currently playing (0 or 1)
    abortController: null,
  };

  // ── Web Speech voice list ────────────────────────────────────────────────
  function loadVoices() {
    state.voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    return state.voices;
  }
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  function pickWebVoice() {
    const list = loadVoices();
    if (!list.length) return null;
    if (state.voiceURI) {
      const m = list.find(v => v.voiceURI === state.voiceURI);
      if (m) return m;
    }
    return list.find(v => /en[-_]/i.test(v.lang) && v.default)
        || list.find(v => /en[-_]/i.test(v.lang))
        || list[0];
  }

  // ── Persistent audio elements. iOS only honours autoplay on elements first
  // .play()ed inside a user gesture, so we keep them and reuse forever. We
  // prime BOTH on the first user gesture so element B can play later without
  // its own gesture (handled in play()).
  function getAudios() {
    if (!state.audios) {
      const make = () => {
        const a = new Audio();
        a.preload = 'auto';
        a.playsInline = true;
        a._chunkIdx = -1;
        a._url = null;
        return a;
      };
      state.audios = [make(), make()];
    }
    return state.audios;
  }

  // ── Sentence-aware chunking (~280 chars max per chunk) ──────────────────
  function chunk(text) {
    const out = [];
    const parts = text.replace(/\s+/g, ' ').trim().split(/(?<=[\.\?\!])\s+/);
    let buf = '';
    for (const p of parts) {
      if (!p) continue;
      if ((buf + ' ' + p).trim().length > CHUNK_MAX && buf) {
        out.push(buf.trim()); buf = p;
      } else {
        buf = buf ? buf + ' ' + p : p;
      }
    }
    if (buf) out.push(buf.trim());
    return out;
  }

  // ── Echo: fetch one chunk's audio. Throws AbortError on stop. ────────────
  async function fetchEchoChunk(text, signal) {
    const r = await fetch(ECHO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ECHO_VOICE, speed: state.rate }),
      signal,
    });
    if (!r.ok) throw new Error('echo http ' + r.status);
    const blob = await r.blob();
    return URL.createObjectURL(blob);
  }

  // ── Pre-load chunk `chunkIdx` into audio element `elIdx` so it's ready to
  // play instantly when the active element finishes. Returns when the URL
  // is set on the element (browser decodes it in the background).
  async function preloadInto(elIdx, chunkIdx) {
    if (!state.playing) return;
    if (chunkIdx < 0 || chunkIdx >= state.chunks.length) return;
    const el = state.audios[elIdx];
    // Already preloaded? skip
    if (el._chunkIdx === chunkIdx && el._url) return;

    let url;
    try {
      url = await fetchEchoChunk(state.chunks[chunkIdx], state.abortController.signal);
    } catch (e) {
      if (e.name === 'AbortError' || !state.playing) return;
      // Network failure — fall back happens lazily when handing-over to this slot
      return;
    }
    if (!state.playing) { URL.revokeObjectURL(url); return; }
    // Free any previous URL on this element
    if (el._url) { URL.revokeObjectURL(el._url); el._url = null; }
    el.src = url;
    el._url = url;
    el._chunkIdx = chunkIdx;
    try { el.load(); } catch (_) {}
  }

  // ── Play whichever audio element holds chunk `chunkIdx`. If it isn't loaded
  // yet, load synchronously here.
  async function playFromCursor() {
    if (!state.playing) return;
    if (state.cursor >= state.chunks.length) return finish();

    const elIdx = state.activeIdx;
    const el = state.audios[elIdx];

    // If the active element doesn't already have our chunk loaded, fetch it now.
    if (el._chunkIdx !== state.cursor) {
      try {
        const url = await fetchEchoChunk(state.chunks[state.cursor], state.abortController.signal);
        if (!state.playing) { URL.revokeObjectURL(url); return; }
        if (el._url) URL.revokeObjectURL(el._url);
        el.src = url;
        el._url = url;
        el._chunkIdx = state.cursor;
      } catch (e) {
        if (e.name === 'AbortError' || !state.playing) return;
        // Echo unreachable mid-playback → finish remaining chunks via Web Speech
        console.warn('[TTS] Echo unreachable, falling back to device voice:', e.message);
        state.engine = 'web';
        return speakWebChunk();
      }
    }

    if (state.onChunkStart) state.onChunkStart(state.cursor, state.chunks[state.cursor]);

    el.onended = () => {
      // Free this chunk's URL right away
      if (el._url) { URL.revokeObjectURL(el._url); el._url = null; el._chunkIdx = -1; }
      const finishedIdx = state.cursor;
      if (state.onChunkEnd) state.onChunkEnd(finishedIdx);
      state.cursor = finishedIdx + 1;
      if (!state.playing) return;
      // Hand off to the OTHER element (which should already be preloaded)
      state.activeIdx = 1 - elIdx;
      playFromCursor();
    };
    el.onerror = () => {
      // Skip this chunk and continue
      if (el._url) { URL.revokeObjectURL(el._url); el._url = null; el._chunkIdx = -1; }
      state.cursor += 1;
      state.activeIdx = 1 - elIdx;
      if (state.playing) playFromCursor();
    };

    try { await el.play(); } catch (_) { /* iOS gesture race; onended will not fire — recover below */ }

    // Kick off prefetch for the NEXT chunk into the inactive element
    preloadInto(1 - elIdx, state.cursor + 1);
  }

  function speakWebChunk() {
    if (!state.playing) return;
    if (state.cursor >= state.chunks.length) return finish();
    if (!window.speechSynthesis) return finish();

    const text = state.chunks[state.cursor];
    const u = new SpeechSynthesisUtterance(text);
    const v = pickWebVoice(); if (v) u.voice = v;
    u.rate = state.rate; u.pitch = 1.0;
    u.onstart = () => { if (state.onChunkStart) state.onChunkStart(state.cursor, text); };
    u.onend = () => {
      if (state.onChunkEnd) state.onChunkEnd(state.cursor);
      state.cursor += 1;
      if (state.playing) speakWebChunk();
    };
    u.onerror = () => {
      state.cursor += 1;
      if (state.playing) speakWebChunk();
    };
    state.currentUtterance = u;
    speechSynthesis.speak(u);
  }

  function finish() {
    state.playing = false;
    state.paused = false;
    if (state.onStop) state.onStop();
  }

  function hardReset() {
    state.playing = false;
    state.paused = false;
    if (window.speechSynthesis) {
      try { speechSynthesis.cancel(); } catch (_) {}
    }
    state.currentUtterance = null;
    if (state.abortController) {
      try { state.abortController.abort(); } catch (_) {}
      state.abortController = null;
    }
    if (state.audios) {
      for (const el of state.audios) {
        try {
          el.pause();
          if (el._url) { URL.revokeObjectURL(el._url); el._url = null; }
          el.removeAttribute('src');
          el._chunkIdx = -1;
          el.load();
        } catch (_) {}
      }
    }
    state.chunks = [];
    state.cursor = 0;
    state.activeIdx = 0;
  }

  // 1-sample silent WAV — used to "unlock" both audio elements inside the
  // initial user gesture so element B can play later without its own gesture.
  const SILENT_WAV =
    'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

  return {
    get voices() { return loadVoices(); },
    setVoice(uri) { state.voiceURI = uri; },
    setRate(r) { state.rate = Math.max(0.5, Math.min(2.5, Number(r) || 1.0)); },
    setUseEcho(b) { state.useEcho = !!b; },
    isUsingEcho: () => state.useEcho,
    isPlaying: () => state.playing,
    isPaused: () => state.paused,
    isUsingFallback: () => state.engine === 'web' && state.useEcho,

    // MUST be invoked from a user gesture (click handler) on iOS so that the
    // first audio.play() / speechSynthesis.speak() is allowed.
    play(text, hooks = {}) {
      hardReset();
      state.chunks = chunk(text);
      if (!state.chunks.length) {
        if (hooks.onStop) hooks.onStop();
        return;
      }
      state.cursor = 0;
      state.activeIdx = 0;
      state.playing = true;
      state.paused = false;
      state.engine = state.useEcho ? 'echo' : 'web';
      state.onChunkStart = hooks.onChunkStart || null;
      state.onChunkEnd = hooks.onChunkEnd || null;
      state.onStop = hooks.onStop || null;
      state.abortController = new AbortController();

      if (state.engine === 'echo') {
        // Prime BOTH audio elements with a silent clip inside this gesture so
        // either one can be .play()'d later without its own gesture (iOS).
        const audios = getAudios();
        for (const el of audios) {
          try {
            el.src = SILENT_WAV;
            const p = el.play();
            if (p && p.then) p.then(() => el.pause()).catch(() => {});
          } catch (_) {}
        }
        // Begin playback (will fetch chunk 0, play, then prefetch chunk 1)
        playFromCursor();
      } else {
        speakWebChunk();
      }
    },

    pause() {
      if (!state.playing || state.paused) return;
      state.paused = true;
      if (state.engine === 'echo') {
        if (state.audios) {
          try { state.audios[state.activeIdx].pause(); } catch (_) {}
        }
      } else if (window.speechSynthesis) {
        try { speechSynthesis.pause(); } catch (_) {}
      }
    },

    resume() {
      if (!state.paused) return;
      state.paused = false;
      if (state.engine === 'echo') {
        if (state.audios) state.audios[state.activeIdx].play().catch(() => {});
      } else if (window.speechSynthesis) {
        try { speechSynthesis.resume(); } catch (_) {}
      }
    },

    stop() {
      const cb = state.onStop;
      hardReset();
      if (cb) cb();
    },
  };
})();

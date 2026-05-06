// Read-aloud engine.
//
// Two engines, one API:
//   - "echo"  → Kokoro neural TTS via the Mac mini (https://tts.aiprofits.cc),
//               played back through the Web Audio API for sample-accurate,
//               gapless playback with no boundary clicks.
//   - "web"   → the browser's built-in SpeechSynthesis (works offline,
//               sounds robotic on iOS — used as a fallback only).
//
// Why Web Audio API and not <audio>: HTML5 audio elements have a load+decode
// gap when you swap their `src` between chunks (~50–200ms), which sounds like
// a tick. Two-element ping-pong with iOS's gesture-priming requirement also
// produces comb-filtering ("talking in a can") when the priming clip races
// with the real chunk. Web Audio decodes ahead of time and schedules each
// chunk on the audio clock, so there's no gap and no overlap — ever.
const TTS = (() => {
  const ECHO_ENDPOINT = 'https://tts.aiprofits.cc/api/tts';
  const CLONE_ENDPOINT = 'https://tts.aiprofits.cc/api/clone-tts';
  const ECHO_VOICE = 'am_echo';
  const CHUNK_MAX = 280;

  const state = {
    rate: 1.0,
    voiceURI: null,
    // engineMode is the user's preference; engine is what's actually
    // running this session (may flip to 'web' if echo/clone fail).
    //   'echo'  — Kokoro on Mac mini (online, best quality)
    //   'clone' — F5-TTS on Mac mini in user's own voice (online, personal)
    //   'web'   — iOS / Android device speech (offline fallback)
    engineMode: 'echo',
    cloneRefId: null,
    engine: 'echo',
    playing: false,
    paused: false,
    chunks: [],
    cursor: 0,
    onChunkStart: null,
    onChunkEnd: null,
    onStop: null,
    // Bumped every time play() or stop() is called. Lets in-flight async work
    // (fetch, decodeAudioData, web-speech callbacks) detect "I'm from a stale
    // session" and bail out instead of acting on a new playback by accident.
    sessionId: 0,
    // Web Speech
    voices: [],
    currentUtterance: null,
    // <audio>-element playback (replaces Web Audio scheduling). Single
    // persistent element so iOS keeps its audio session alive across chunk
    // transitions — required for lock-screen / background playback. Web
    // Audio scheduling was beautifully gapless but iOS suspends AudioContext
    // the moment the screen locks, so it's foreground-only.
    audioEl: null,
    blobUrls: new Set(),       // currently-allocated blob URLs (revoked on stop)
    prefetchPromise: null,     // promise for the chunk we're racing to fetch
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

  function getAudioElement() {
    if (!state.audioEl) {
      const a = new Audio();
      a.preload = 'auto';
      // Tell iOS this is real media so it keeps playing in background.
      // Without this attribute the element sometimes gets paused on lock.
      a.setAttribute('playsinline', 'true');
      state.audioEl = a;
    }
    return state.audioEl;
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

  async function fetchEchoBytes(text, signal) {
    // Pick endpoint + body shape based on engine. Both return audio/wav.
    const useClone = state.engine === 'clone' && state.cloneRefId;
    const url = useClone ? CLONE_ENDPOINT : ECHO_ENDPOINT;
    const body = useClone
      ? { text, ref_id: state.cloneRefId, speed: state.rate }
      : { text, voice: ECHO_VOICE, speed: state.rate };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!r.ok) throw new Error((useClone ? 'clone' : 'echo') + ' http ' + r.status);
    return await r.arrayBuffer();
  }

  // iOS gates speechSynthesis behind a user gesture: the FIRST call to
  // .speak() must happen inside a tap/click handler, otherwise it's
  // silently ignored. When Echo fails mid-async-fetch and we then try to
  // fall back to speech, we're outside the gesture and the speech goes
  // nowhere. Solution: speak a silent utterance inside the gesture so
  // iOS marks the session as "allowed to speak" for the rest of the page.
  let _speechPrimed = false;
  function primeSpeechSynthesis() {
    if (_speechPrimed) return;
    if (!window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
      _speechPrimed = true;
    } catch (_) { /* ignore */ }
  }

  // Fetch one chunk, return as a blob URL ready to feed to <audio>.
  // Tracks the blob URL so hardReset() can revoke it on stop.
  async function fetchChunkAsBlobUrl(text, signal) {
    const arrayBuffer = await fetchEchoBytes(text, signal);
    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    state.blobUrls.add(url);
    return url;
  }

  // Play the chunk queue through a single persistent <audio> element.
  // When chunk N ends, swap in N+1. Pre-fetches N+1 while N plays so the
  // gap between chunks is as short as possible (still won't be sample-
  // accurate gapless like the old Web Audio path, but iOS keeps <audio>
  // playing in background, which Web Audio doesn't).
  async function playEchoFromIndex(sessionId, idx) {
    if (sessionId !== state.sessionId || !state.playing) return;
    if (idx >= state.chunks.length) return finish(sessionId);

    let blobUrl;
    try {
      // If the prefetcher already has this chunk ready, use it; otherwise fetch.
      if (state.prefetchPromise && state.prefetchPromise._idx === idx) {
        blobUrl = await state.prefetchPromise;
      } else {
        blobUrl = await fetchChunkAsBlobUrl(state.chunks[idx], state.abortController.signal);
      }
      if (sessionId !== state.sessionId || !state.playing) return;
    } catch (e) {
      if (e.name === 'AbortError' || sessionId !== state.sessionId || !state.playing) return;
      console.warn('[TTS] Echo unreachable, falling back to device voice:', e.message);
      state.engine = 'web';
      state.cursor = idx;
      // Tell the app so it can toast — otherwise the user just hears a
      // sudden voice change with no explanation.
      if (state.onFallback) state.onFallback('echo-unreachable', e);
      return speakWebChunk(sessionId);
    }

    const audio = getAudioElement();
    audio.onended = () => {
      if (sessionId !== state.sessionId) return;
      try { URL.revokeObjectURL(blobUrl); state.blobUrls.delete(blobUrl); } catch (_) {}
      if (state.onChunkEnd) state.onChunkEnd(idx);
      playEchoFromIndex(sessionId, idx + 1);
    };
    audio.onerror = () => {
      if (sessionId !== state.sessionId) return;
      console.warn('[TTS] <audio> error on chunk', idx, audio.error);
      try { URL.revokeObjectURL(blobUrl); state.blobUrls.delete(blobUrl); } catch (_) {}
      // Fall back to web speech for the rest of the page.
      state.engine = 'web';
      state.cursor = idx;
      speakWebChunk(sessionId);
    };
    audio.src = blobUrl;
    audio.playbackRate = state.rate;
    state.cursor = idx;
    if (state.onChunkStart) state.onChunkStart(idx, state.chunks[idx]);

    try {
      await audio.play();
    } catch (e) {
      // Autoplay rejected — most commonly because we're not in a user
      // gesture chain anymore (e.g. resume from background). Surface as
      // pause so the lock-screen play button can resume.
      console.warn('[TTS] audio.play() rejected:', e.name, e.message);
      state.paused = true;
      return;
    }

    // Pre-fetch the next chunk while this one plays so the swap gap stays
    // small. Track the index on the promise so we don't reuse it for a
    // different chunk after a stop/replay.
    if (idx + 1 < state.chunks.length) {
      const p = fetchChunkAsBlobUrl(state.chunks[idx + 1], state.abortController.signal)
        .catch(e => { if (e.name !== 'AbortError') console.warn('[TTS] prefetch failed:', e.message); return null; });
      p._idx = idx + 1;
      state.prefetchPromise = p;
    } else {
      state.prefetchPromise = null;
    }
  }

  // Web Speech path: speak the WHOLE page text in a single utterance and
  // let the underlying engine (Piper / iOS / Apple voice) handle internal
  // sentence splitting + streaming. The previous chunked implementation
  // sent ~280-char fragments one at a time, which on Android with our
  // custom Piper engine produced empty-utterance artifacts and a
  // "page turns silently" symptom because each chunk's onend fired
  // before audio drained, then the next utterance preempted whatever
  // was still queued. One utterance = one onend = no race.
  function speakWebChunk(sessionId) {
    if (sessionId !== state.sessionId || !state.playing) return;
    if (!window.speechSynthesis) return finish(sessionId);

    // Join all chunks into a single text. We still keep the chunked
    // representation in state.chunks so app.js's marker / position
    // logic doesn't have to change, but only ONE utterance ever fires.
    const text = state.chunks.slice(state.cursor).join(' ').trim();
    if (!text) return finish(sessionId);

    const u = new SpeechSynthesisUtterance(text);
    const v = pickWebVoice(); if (v) u.voice = v;
    u.rate = state.rate; u.pitch = 1.0;
    const myCursor = state.cursor;
    let lastReportedIdx = -1;
    u.onstart = () => {
      if (sessionId !== state.sessionId) return;
      if (state.onChunkStart) state.onChunkStart(myCursor, text);
    };
    // Browser fires onboundary as it advances through the utterance.
    // Use the charIndex to compute progress and map it to a virtual
    // chunk index — keeps the reading-position marker advancing even
    // though we're now sending the whole page in a single utterance.
    u.onboundary = (event) => {
      if (sessionId !== state.sessionId) return;
      if (!state.onChunkStart) return;
      const charIdx = (event && typeof event.charIndex === 'number') ? event.charIndex : 0;
      const progress = charIdx / Math.max(1, text.length);
      const virtualIdx = Math.min(state.chunks.length - 1, Math.floor(progress * state.chunks.length));
      if (virtualIdx !== lastReportedIdx) {
        lastReportedIdx = virtualIdx;
        state.onChunkStart(virtualIdx, text);
      }
    };
    u.onend = () => {
      if (sessionId !== state.sessionId) return;
      if (state.onChunkEnd) state.onChunkEnd(myCursor);
      // Whole page was spoken — finish (no recursion since we sent it all
      // in a single utterance). app.js's onStop hook handles auto-advance.
      state.cursor = state.chunks.length;
      finish(sessionId);
    };
    u.onerror = (ev) => {
      if (sessionId !== state.sessionId) return;
      console.warn('[TTS] web speech error:', ev && ev.error);
      state.cursor = state.chunks.length;
      finish(sessionId);
    };
    state.currentUtterance = u;
    speechSynthesis.speak(u);
  }

  function finish(sessionId) {
    if (sessionId !== state.sessionId) return;
    state.playing = false;
    state.paused = false;
    if (state.onStop) state.onStop();
  }

  // Stop everything immediately and irreversibly. Bumps sessionId so any
  // in-flight async callbacks self-abort when they wake up.
  function hardReset() {
    state.sessionId += 1;
    state.playing = false;
    state.paused = false;

    // Web Speech: a single synchronous cancel(). The previous code queued
    // a SECOND cancel() as a microtask "to be sure on iOS" — but that
    // microtask ran AFTER the new utterance was speak()'d in the same
    // play() call, cancelling everything we just queued. On Android with
    // Piper this killed every page (one-second-per-page silent flip-
    // through); on iOS it had been silently eating chunk 0 forever
    // (= "first paragraph missing"). One cancel() is enough; modern
    // browsers all handle it synchronously.
    if (window.speechSynthesis) {
      try { speechSynthesis.cancel(); } catch (_) {}
    }
    state.currentUtterance = null;

    if (state.abortController) {
      try { state.abortController.abort(); } catch (_) {}
      state.abortController = null;
    }

    // <audio> path: pause, drop the current source, revoke any blob URLs we
    // allocated. Don't destroy the element itself — keeping it alive lets
    // a follow-up play() resume in the same iOS audio session.
    if (state.audioEl) {
      try {
        state.audioEl.onended = null;
        state.audioEl.onerror = null;
        state.audioEl.pause();
        state.audioEl.removeAttribute('src');
        state.audioEl.load();
      } catch (_) {}
    }
    for (const url of state.blobUrls) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    state.blobUrls.clear();
    state.prefetchPromise = null;

    state.chunks = [];
    state.cursor = 0;
  }

  return {
    get voices() { return loadVoices(); },
    setVoice(uri) { state.voiceURI = uri; },
    setRate(r) {
      state.rate = Math.max(0.5, Math.min(2.5, Number(r) || 1.0));
      if (state.audioEl) state.audioEl.playbackRate = state.rate;
    },
    // Three-way engine selection: 'echo' | 'clone' | 'web'.
    setEngineMode(mode) {
      if (!['echo', 'clone', 'web'].includes(mode)) return;
      state.engineMode = mode;
    },
    getEngineMode: () => state.engineMode,
    setCloneRefId(id) { state.cloneRefId = id || null; },
    getCloneRefId: () => state.cloneRefId,
    // Back-compat shim: some older callers still flip useEcho.
    setUseEcho(b) { state.engineMode = b ? 'echo' : 'web'; },
    isUsingEcho: () => state.engineMode === 'echo',
    isPlaying: () => state.playing,
    isPaused: () => state.paused,
    isUsingFallback: () => state.engine === 'web' && state.useEcho,
    // Exposed so the app can pre-compute chunk count + character offsets,
    // align them with text positions on the page, and drive a "now reading"
    // marker. play() will produce identical chunks via this same function.
    chunk(text) { return chunk(text); },

    // MUST be invoked from a user gesture (click handler) on iOS so that the
    // first AudioContext.resume() / speechSynthesis.speak() is allowed.
    play(text, hooks = {}) {
      hardReset();                 // bumps sessionId
      const sessionId = state.sessionId;
      state.chunks = chunk(text);
      if (!state.chunks.length) {
        if (hooks.onStop) hooks.onStop();
        return;
      }
      state.cursor = 0;
      state.playing = true;
      state.paused = false;
      // The engine for this play() call: prefer the user's mode, but
      // fall through to 'web' if 'clone' was chosen with no ref selected.
      state.engine = state.engineMode === 'clone' && state.cloneRefId
        ? 'clone'
        : (state.engineMode === 'echo' ? 'echo' : 'web');
      state.onChunkStart = hooks.onChunkStart || null;
      state.onChunkEnd = hooks.onChunkEnd || null;
      state.onStop = hooks.onStop || null;
      state.onFallback = hooks.onFallback || null;
      state.abortController = new AbortController();

      // Prime BOTH playback paths inside the user gesture so iOS lets
      // either fire later. Audio element gets touched (creating it
      // associates it with the gesture); speech synthesis gets a silent
      // utterance so we can fall back to it from an async fetch failure.
      getAudioElement();
      primeSpeechSynthesis();

      if (state.engine === 'echo' || state.engine === 'clone') {
        // Fast-path: if the browser knows we're offline, don't bother
        // with the network fetch — it'd fail anyway, and the failure
        // takes long enough that the user assumes "nothing happens."
        // Notify via hooks so the app can toast "using device voice."
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          state.engine = 'web';
          if (hooks.onFallback) hooks.onFallback('offline');
          return speakWebChunk(sessionId);
        }
        playEchoFromIndex(sessionId, 0);
      } else {
        speakWebChunk(sessionId);
      }
    },

    pause() {
      if (!state.playing || state.paused) return;
      state.paused = true;
      if (state.engine === 'echo' && state.audioEl) {
        try { state.audioEl.pause(); } catch (_) {}
      } else if (window.speechSynthesis) {
        try { speechSynthesis.pause(); } catch (_) {}
      }
    },
    resume() {
      if (!state.paused) return;
      state.paused = false;
      if (state.engine === 'echo' && state.audioEl) {
        state.audioEl.play().catch(e => console.warn('[TTS] resume failed:', e.message));
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

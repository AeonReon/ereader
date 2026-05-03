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
  const ECHO_VOICE = 'am_echo';
  const CHUNK_MAX = 280;

  const state = {
    rate: 1.0,
    voiceURI: null,
    useEcho: true,
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
    // Web Audio
    audioCtx: null,
    activeSources: new Set(),
    nextStartTime: 0,
    schedulingChunkIdx: 0,
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

  function getAudioContext() {
    if (!state.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      state.audioCtx = new Ctx();
    }
    return state.audioCtx;
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
    const r = await fetch(ECHO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: ECHO_VOICE, speed: state.rate }),
      signal,
    });
    if (!r.ok) throw new Error('echo http ' + r.status);
    return await r.arrayBuffer();
  }

  // Fetch chunk N, decode, schedule it on the audio clock, then schedule N+1.
  async function scheduleNextChunk(sessionId) {
    if (sessionId !== state.sessionId || !state.playing) return;
    const idx = state.schedulingChunkIdx;
    if (idx >= state.chunks.length) return;
    state.schedulingChunkIdx = idx + 1;

    let buffer;
    try {
      const arrayBuffer = await fetchEchoBytes(
        state.chunks[idx],
        state.abortController.signal
      );
      if (sessionId !== state.sessionId || !state.playing) return;
      const ctx = getAudioContext();
      if (!ctx) throw new Error('no audio context');
      buffer = await ctx.decodeAudioData(arrayBuffer);
    } catch (e) {
      if (e.name === 'AbortError' || sessionId !== state.sessionId || !state.playing) return;
      console.warn('[TTS] Echo unreachable, falling back to device voice:', e.message);
      state.engine = 'web';
      state.cursor = idx;
      return speakWebChunk(sessionId);
    }
    if (sessionId !== state.sessionId || !state.playing) return;

    const ctx = getAudioContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime + 0.005, state.nextStartTime);
    state.nextStartTime = startAt + buffer.duration;
    state.activeSources.add(source);

    const startsInMs = Math.max(0, (startAt - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (sessionId !== state.sessionId || !state.activeSources.has(source)) return;
      state.cursor = idx;
      if (state.onChunkStart) state.onChunkStart(idx, state.chunks[idx]);
    }, startsInMs);

    source.onended = () => {
      state.activeSources.delete(source);
      if (sessionId !== state.sessionId) return;
      if (state.onChunkEnd) state.onChunkEnd(idx);
      // Last chunk, no more sources scheduled → done.
      if (idx === state.chunks.length - 1 && state.activeSources.size === 0
          && state.schedulingChunkIdx >= state.chunks.length) {
        finish(sessionId);
      }
    };
    source.start(startAt);

    if (state.schedulingChunkIdx < state.chunks.length) {
      scheduleNextChunk(sessionId);
    }
  }

  function speakWebChunk(sessionId) {
    if (sessionId !== state.sessionId || !state.playing) return;
    if (state.cursor >= state.chunks.length) return finish(sessionId);
    if (!window.speechSynthesis) return finish(sessionId);

    const text = state.chunks[state.cursor];
    const u = new SpeechSynthesisUtterance(text);
    const v = pickWebVoice(); if (v) u.voice = v;
    u.rate = state.rate; u.pitch = 1.0;
    const myCursor = state.cursor;
    u.onstart = () => {
      if (sessionId !== state.sessionId) return;
      if (state.onChunkStart) state.onChunkStart(myCursor, text);
    };
    u.onend = () => {
      if (sessionId !== state.sessionId) return;
      if (state.onChunkEnd) state.onChunkEnd(myCursor);
      state.cursor = myCursor + 1;
      if (state.playing) speakWebChunk(sessionId);
    };
    u.onerror = () => {
      if (sessionId !== state.sessionId) return;
      state.cursor = myCursor + 1;
      if (state.playing) speakWebChunk(sessionId);
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

    // Web Speech — cancel() on iOS isn't always immediate, so call it twice
    // around a microtask boundary to flush more reliably.
    if (window.speechSynthesis) {
      try { speechSynthesis.cancel(); } catch (_) {}
      Promise.resolve().then(() => {
        try { speechSynthesis.cancel(); } catch (_) {}
      });
    }
    state.currentUtterance = null;

    if (state.abortController) {
      try { state.abortController.abort(); } catch (_) {}
      state.abortController = null;
    }

    // Web Audio — stop and disconnect every scheduled source. .stop() on a
    // not-yet-started source cancels its scheduled start; on a playing source
    // it stops immediately. Either way it's safe.
    for (const src of state.activeSources) {
      try { src.onended = null; src.stop(); src.disconnect(); } catch (_) {}
    }
    state.activeSources.clear();

    state.nextStartTime = 0;
    state.schedulingChunkIdx = 0;
    state.chunks = [];
    state.cursor = 0;
  }

  return {
    get voices() { return loadVoices(); },
    setVoice(uri) { state.voiceURI = uri; },
    setRate(r) { state.rate = Math.max(0.5, Math.min(2.5, Number(r) || 1.0)); },
    setUseEcho(b) { state.useEcho = !!b; },
    isUsingEcho: () => state.useEcho,
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
      state.engine = state.useEcho ? 'echo' : 'web';
      state.onChunkStart = hooks.onChunkStart || null;
      state.onChunkEnd = hooks.onChunkEnd || null;
      state.onStop = hooks.onStop || null;
      state.abortController = new AbortController();

      if (state.engine === 'echo') {
        const ctx = getAudioContext();
        if (!ctx) {
          state.engine = 'web';
          return speakWebChunk(sessionId);
        }
        // Resume the context inside the user gesture (iOS "unlock"). Safe to
        // call even if not suspended — it's a no-op then.
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        state.nextStartTime = ctx.currentTime + 0.01;
        scheduleNextChunk(sessionId);
      } else {
        speakWebChunk(sessionId);
      }
    },

    pause() {
      if (!state.playing || state.paused) return;
      state.paused = true;
      if (state.engine === 'echo' && state.audioCtx) {
        state.audioCtx.suspend().catch(() => {});
      } else if (window.speechSynthesis) {
        try { speechSynthesis.pause(); } catch (_) {}
      }
    },
    resume() {
      if (!state.paused) return;
      state.paused = false;
      if (state.engine === 'echo' && state.audioCtx) {
        state.audioCtx.resume().catch(() => {});
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

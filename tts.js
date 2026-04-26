// Read-aloud engine.
//
// Two engines, one API:
//   - "echo"  → Kokoro neural TTS via the Mac mini (https://tts.websitesupport.site).
//               Same Echo voice used in PDF Studio and the AI chat. Sounds great.
//   - "web"   → the browser's built-in SpeechSynthesis (works offline, sounds robotic on iOS).
//
// Echo is the default. If a fetch fails (Mac mini sleeping, no internet) we silently
// fall back to "web" mid-stream so playback never just dies.
//
// Stopping is robust: aborts in-flight fetches, pauses the persistent <audio>
// element, cancels any queued speech utterances, clears state.
const TTS = (() => {
  const ECHO_ENDPOINT = 'https://tts.websitesupport.site/api/tts';
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
    index: 0,
    onChunkStart: null,
    onChunkEnd: null,
    onStop: null,
    // Web Speech
    voices: [],
    currentUtterance: null,
    // Echo
    audio: null,            // persistent <audio> element — must be reused on iOS
    abortController: null,
    prefetch: null,         // { idx, promise } — next chunk being fetched in parallel
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

  // ── Persistent <audio> element. iOS only honours autoplay on an element that
  // was first .play()ed inside a user gesture, so we keep a single one and
  // swap its `src` between chunks rather than constructing new Audio() objects.
  function getAudio() {
    if (!state.audio) {
      const a = new Audio();
      a.preload = 'auto';
      a.playsInline = true;
      state.audio = a;
    }
    return state.audio;
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

  async function speakEchoChunk() {
    if (!state.playing) return;
    if (state.index >= state.chunks.length) return finish();

    let url;
    try {
      if (state.prefetch && state.prefetch.idx === state.index && state.prefetch.promise) {
        url = await state.prefetch.promise;
        state.prefetch = null;
        if (!url) throw new Error('prefetch returned null');
      } else {
        url = await fetchEchoChunk(state.chunks[state.index], state.abortController.signal);
      }
    } catch (e) {
      if (e.name === 'AbortError' || !state.playing) return;
      // Echo unreachable mid-playback → fall back to Web Speech for the rest
      console.warn('[TTS] Echo unreachable, falling back to device voice:', e.message);
      state.engine = 'web';
      return speakWebChunk();
    }
    if (!state.playing) { URL.revokeObjectURL(url); return; }

    const audio = getAudio();
    audio.src = url;
    if (state.onChunkStart) state.onChunkStart(state.index, state.chunks[state.index]);

    // Kick off the next chunk's fetch in parallel for gapless playback
    const nextIdx = state.index + 1;
    if (nextIdx < state.chunks.length && state.abortController) {
      const sig = state.abortController.signal;
      state.prefetch = {
        idx: nextIdx,
        promise: fetchEchoChunk(state.chunks[nextIdx], sig).catch(() => null),
      };
    }

    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (state.onChunkEnd) state.onChunkEnd(state.index);
      state.index += 1;
      if (state.playing) speakEchoChunk();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      state.index += 1;
      if (state.playing) speakEchoChunk();
    };
    try { await audio.play(); } catch (_) { /* iOS gesture race — onended will retry */ }
  }

  function speakWebChunk() {
    if (!state.playing) return;
    if (state.index >= state.chunks.length) return finish();
    if (!window.speechSynthesis) return finish();

    const text = state.chunks[state.index];
    const u = new SpeechSynthesisUtterance(text);
    const v = pickWebVoice(); if (v) u.voice = v;
    u.rate = state.rate; u.pitch = 1.0;
    u.onstart = () => { if (state.onChunkStart) state.onChunkStart(state.index, text); };
    u.onend = () => {
      if (state.onChunkEnd) state.onChunkEnd(state.index);
      state.index += 1;
      if (state.playing) speakWebChunk();
    };
    u.onerror = () => {
      state.index += 1;
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
    if (state.audio) {
      try {
        state.audio.pause();
        state.audio.removeAttribute('src');
        state.audio.load();
      } catch (_) {}
    }
    state.prefetch = null;
    state.chunks = [];
    state.index = 0;
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

    // MUST be invoked from a user gesture (click handler) on iOS so that the
    // first audio.play() / speechSynthesis.speak() is allowed.
    play(text, hooks = {}) {
      hardReset();
      state.chunks = chunk(text);
      if (!state.chunks.length) {
        if (hooks.onStop) hooks.onStop();
        return;
      }
      state.index = 0;
      state.playing = true;
      state.paused = false;
      state.engine = state.useEcho ? 'echo' : 'web';
      state.onChunkStart = hooks.onChunkStart || null;
      state.onChunkEnd = hooks.onChunkEnd || null;
      state.onStop = hooks.onStop || null;
      state.abortController = new AbortController();

      if (state.engine === 'echo') {
        getAudio();              // prime the persistent <audio> element
        speakEchoChunk();
      } else {
        speakWebChunk();
      }
    },

    pause() {
      if (!state.playing || state.paused) return;
      state.paused = true;
      if (state.engine === 'echo') {
        if (state.audio) try { state.audio.pause(); } catch (_) {}
      } else if (window.speechSynthesis) {
        try { speechSynthesis.pause(); } catch (_) {}
      }
    },

    resume() {
      if (!state.paused) return;
      state.paused = false;
      if (state.engine === 'echo') {
        if (state.audio) state.audio.play().catch(() => {});
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

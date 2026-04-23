// Text-to-speech using the Web Speech API (SpeechSynthesis).
// Chunks text into sentences so iOS Safari stays responsive and firing onend works reliably.
const TTS = (() => {
  const state = {
    voices: [],
    voiceURI: null,
    rate: 1.0,
    pitch: 1.0,
    onBoundary: null,
    onChunkStart: null,
    onChunkEnd: null,
    onStop: null,
    playing: false,
    paused: false,
    chunks: [],
    index: 0,
    current: null,
  };

  function loadVoices() {
    state.voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    return state.voices;
  }

  if (typeof window !== 'undefined' && window.speechSynthesis) {
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }

  function pickVoice() {
    const list = loadVoices();
    if (!list.length) return null;
    if (state.voiceURI) {
      const m = list.find(v => v.voiceURI === state.voiceURI);
      if (m) return m;
    }
    const en = list.find(v => /en[-_]/i.test(v.lang) && v.default)
      || list.find(v => /en[-_]/i.test(v.lang))
      || list[0];
    return en;
  }

  // Split text into sentence-ish chunks (~280 chars max) for smoother playback.
  function chunk(text) {
    const max = 280;
    const out = [];
    const parts = text
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[\.\?\!])\s+/);
    let buf = '';
    for (const p of parts) {
      if (!p) continue;
      if ((buf + ' ' + p).trim().length > max && buf) {
        out.push(buf.trim());
        buf = p;
      } else {
        buf = buf ? buf + ' ' + p : p;
      }
    }
    if (buf) out.push(buf.trim());
    return out;
  }

  function speakIndex() {
    if (state.index >= state.chunks.length) {
      state.playing = false;
      state.current = null;
      if (state.onStop) state.onStop();
      return;
    }
    const text = state.chunks[state.index];
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = state.rate;
    u.pitch = state.pitch;
    u.onstart = () => {
      if (state.onChunkStart) state.onChunkStart(state.index, text);
    };
    u.onend = () => {
      if (state.onChunkEnd) state.onChunkEnd(state.index);
      state.index += 1;
      if (state.playing) speakIndex();
    };
    u.onerror = () => {
      state.index += 1;
      if (state.playing) speakIndex();
    };
    state.current = u;
    speechSynthesis.speak(u);
  }

  return {
    get voices() { return loadVoices(); },
    setVoice(uri) { state.voiceURI = uri; },
    setRate(r) { state.rate = r; },
    isPlaying: () => state.playing,
    isPaused: () => state.paused,
    play(text, hooks = {}) {
      // Cancel any in-flight utterance without firing the caller's onStop,
      // so chained .play() calls (e.g. auto-advance to the next page) don't
      // incorrectly signal "stopped" to the app.
      if (window.speechSynthesis) speechSynthesis.cancel();
      state.chunks = chunk(text);
      if (!state.chunks.length) {
        state.playing = false;
        if (hooks.onStop) hooks.onStop();
        return;
      }
      state.index = 0;
      state.playing = true;
      state.paused = false;
      state.current = null;
      state.onChunkStart = hooks.onChunkStart || null;
      state.onChunkEnd = hooks.onChunkEnd || null;
      state.onStop = hooks.onStop || null;
      speakIndex();
    },
    pause() {
      if (window.speechSynthesis && state.playing && !state.paused) {
        speechSynthesis.pause();
        state.paused = true;
      }
    },
    resume() {
      if (window.speechSynthesis && state.paused) {
        speechSynthesis.resume();
        state.paused = false;
      }
    },
    stop() {
      if (window.speechSynthesis) {
        speechSynthesis.cancel();
      }
      state.playing = false;
      state.paused = false;
      state.current = null;
      state.chunks = [];
      state.index = 0;
      if (state.onStop) state.onStop();
    },
  };
})();

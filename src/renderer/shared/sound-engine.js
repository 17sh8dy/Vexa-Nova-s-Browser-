// Vexa Atmosphere sound engine. Plain script (window.VexaSoundEngine) used by the browser UI
// (which plays every interface sound) and by the Customize drawer (previews).
//
// - Built-in profiles are synthesised with Web Audio: nothing is bundled, decoded or
//   streamed, and a sound costs a handful of short-lived oscillator nodes.
// - Imported files are fetched once from the main process, decoded, and cached.
// - Sounds play in Vexa's own renderer, in its own AudioContext. They never touch a
//   website's audio: no ducking, no pausing, no mixing into the page.
// - The context is suspended after a short idle period, so a quiet browser costs no CPU.
(function (root) {
  'use strict';

  const CATEGORIES = ['typing', 'click', 'tabOpen', 'tabClose', 'tabSwitch', 'pageLoad', 'notification', 'startup', 'shutdown'];
  const MAX_CUSTOM_SECONDS = 8;
  const MIN_GAP = { typing: 28, click: 40 }; // ms between two plays of the same category
  const DEFAULT_GAP = 70;
  const MAX_VOICES = 28;
  const IDLE_SUSPEND_MS = 20000;

  // Profiles: a timbre + a base pitch. Patterns (below) are shared, so every profile has a
  // complete, consistent set of sounds.
  const PROFILES = {
    nova: { name: 'Nova', desc: 'Soft violet shimmer', base: 880, wave: 'sine', overtone: 'triangle', overtoneGain: 0.25, lowpass: 7000, decay: 1, noise: 0.15 },
    soft: { name: 'Soft', desc: 'Low, muted and calm', base: 523.25, wave: 'sine', overtone: null, overtoneGain: 0, lowpass: 2400, decay: 1.2, noise: 0.05 },
    crystal: { name: 'Crystal', desc: 'Glassy bells', base: 1318.5, wave: 'triangle', overtone: 'sine', overtoneGain: 0.4, lowpass: 12000, decay: 1.8, noise: 0 },
    mech: { name: 'Mechanical', desc: 'Clicky keyboard and switches', base: 440, wave: 'square', overtone: null, overtoneGain: 0, lowpass: 1800, decay: 0.7, noise: 1 },
    arcade: { name: 'Arcade', desc: '8-bit blips and arpeggios', base: 659.25, wave: 'square', overtone: 'square', overtoneGain: 0.15, lowpass: 6000, decay: 0.8, noise: 0.1, slide: true }
  };

  // n = semitones from the profile's base, at = start (s), d = duration (s), a = attack (s).
  const PATTERNS = {
    typing: { steps: [{ n: 12, d: 0.022 }], tick: true, gain: 0.35, jitter: 1 },
    click: { steps: [{ n: 7, d: 0.04, slide: -5 }], tick: true, gain: 0.45 },
    tabOpen: { steps: [{ n: 0, d: 0.09 }, { n: 7, at: 0.065, d: 0.14 }], gain: 0.55 },
    tabClose: { steps: [{ n: 7, d: 0.09 }, { n: 0, at: 0.065, d: 0.14 }], gain: 0.5 },
    tabSwitch: { steps: [{ n: 12, d: 0.065 }], gain: 0.4 },
    pageLoad: { steps: [{ n: 4, d: 0.14 }, { n: 11, at: 0.05, d: 0.22 }], gain: 0.32 },
    notification: { steps: [{ n: 0, d: 0.14 }, { n: 4, at: 0.09, d: 0.14 }, { n: 7, at: 0.18, d: 0.34 }], gain: 0.6 },
    startup: { steps: [{ n: -12, d: 1.3, a: 0.32 }, { n: -5, at: 0.1, d: 1.2, a: 0.32 }, { n: 0, at: 0.2, d: 1.1, a: 0.28 }, { n: 4, at: 0.32, d: 1.0, a: 0.24 }, { n: 7, at: 0.46, d: 0.9, a: 0.2 }], gain: 0.42 },
    shutdown: { steps: [{ n: 7, d: 0.5 }, { n: 4, at: 0.12, d: 0.5 }, { n: 0, at: 0.24, d: 0.6 }, { n: -5, at: 0.36, d: 0.8 }], gain: 0.42 }
  };

  class SoundEngine {
    /** @param {{ fetchCustom: (id: string) => Promise<ArrayBuffer|Uint8Array> }} opts */
    constructor({ fetchCustom } = {}) {
      this.fetchCustom = fetchCustom || null;
      this.config = { enabled: false, volume: 60, profile: 'nova', categories: {} };
      this.ctx = null;
      this.master = null;
      this.voices = 0;
      this.last = {};
      this.buffers = new Map(); // id -> AudioBuffer | 'bad'
      this.loading = new Map(); // id -> Promise
      this.idleTimer = null;
      this.noiseBuf = null;
    }

    configure(config) {
      this.config = { ...this.config, ...(config || {}) };
      // Drop decoded files nothing refers to any more.
      const used = new Set(Object.values(this.config.categories || {}).map((c) => c && c.custom).filter(Boolean));
      for (const id of this.buffers.keys()) if (!used.has(id)) this.buffers.delete(id);
      if (this.config.enabled) for (const id of used) this._load(id).catch(() => {});
    }

    _ensure() {
      if (!this.ctx) {
        const Ctx = root.AudioContext || root.webkitAudioContext;
        if (!Ctx) return null;
        this.ctx = new Ctx({ latencyHint: 'interactive' });
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 6;
        this.master = this.ctx.createGain();
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.ctx && this.voices <= 0) this.ctx.suspend().catch(() => {});
      }, IDLE_SUSPEND_MS);
      return this.ctx;
    }

    async _load(id) {
      if (!id || !this.fetchCustom) return null;
      const have = this.buffers.get(id);
      if (have) return have === 'bad' ? null : have;
      if (this.loading.has(id)) return this.loading.get(id);
      const p = (async () => {
        try {
          const ctx = this._ensure();
          if (!ctx) return null;
          const bytes = await this.fetchCustom(id);
          if (!bytes) throw new Error('missing');
          const ab = bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          const buf = await ctx.decodeAudioData(ab);
          if (buf.duration > MAX_CUSTOM_SECONDS) throw new Error('too long');
          this.buffers.set(id, buf);
          return buf;
        } catch {
          this.buffers.set(id, 'bad');
          return null;
        } finally {
          this.loading.delete(id);
        }
      })();
      this.loading.set(id, p);
      return p;
    }

    /** Check an imported file can be decoded and is short enough (used before saving it). */
    async probe(bytes) {
      const ctx = this._ensure();
      if (!ctx) throw new Error('Audio is not available');
      const ab = bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const buf = await ctx.decodeAudioData(ab);
      if (buf.duration > MAX_CUSTOM_SECONDS) throw new Error(`Sounds can be up to ${MAX_CUSTOM_SECONDS} seconds long`);
      return { duration: buf.duration, channels: buf.numberOfChannels };
    }

    /**
     * Play a category. opts: { force (ignore enabled/on), profile, custom, volume (0-100 category) }.
     */
    play(category, opts = {}) {
      if (!CATEGORIES.includes(category)) return;
      const cfg = this.config;
      const cat = (cfg.categories && cfg.categories[category]) || { on: true, volume: 70, custom: '' };
      if (!opts.force && (!cfg.enabled || !cat.on)) return;
      const now = performance.now();
      if (!opts.force && now - (this.last[category] || 0) < (MIN_GAP[category] || DEFAULT_GAP)) return;
      this.last[category] = now;
      if (this.voices >= MAX_VOICES) return;
      const ctx = this._ensure();
      if (!ctx) return;
      const vol = ((opts.masterVolume ?? cfg.volume) / 100) * ((opts.volume ?? cat.volume) / 100);
      if (vol <= 0) return;
      const custom = opts.custom !== undefined ? opts.custom : cat.custom;
      if (custom) {
        const buf = this.buffers.get(custom);
        if (buf && buf !== 'bad') return this._playBuffer(buf, vol);
        // Not decoded yet: load it for next time, play the profile sound now.
        this._load(custom).then((b) => opts.force && b && this._playBuffer(b, vol));
        if (opts.force) return;
      }
      this._synth(category, PROFILES[opts.profile || cfg.profile] || PROFILES.nova, vol);
    }

    _voice(dur) {
      this.voices++;
      setTimeout(() => this.voices--, dur * 1000 + 80);
    }

    _playBuffer(buf, vol) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = vol;
      src.connect(g);
      g.connect(this.master);
      src.start();
      this._voice(buf.duration);
    }

    _noise() {
      if (!this.noiseBuf) {
        const ctx = this.ctx;
        const len = Math.floor(ctx.sampleRate * 0.25);
        const b = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noiseBuf = b;
      }
      return this.noiseBuf;
    }

    _synth(category, prof, vol) {
      const ctx = this.ctx;
      const pat = PATTERNS[category];
      const t0 = ctx.currentTime + 0.005;
      const out = ctx.createGain();
      out.gain.value = vol * pat.gain;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = prof.lowpass;
      out.connect(lp);
      lp.connect(this.master);
      let end = 0;
      const jitter = pat.jitter ? (Math.random() * 2 - 1) * pat.jitter : 0;

      for (const st of pat.steps) {
        const at = t0 + (st.at || 0);
        const d = st.d * prof.decay;
        const a = st.a || 0.004;
        const f = prof.base * Math.pow(2, (st.n + jitter) / 12);
        const voices = [[prof.wave, 1, 1]];
        if (prof.overtone) voices.push([prof.overtone, prof.overtoneGain, 2]);
        for (const [type, gain, mul] of voices) {
          if (prof.noise >= 1 && pat.tick) continue; // mechanical typing/click: noise only
          const o = ctx.createOscillator();
          o.type = type;
          o.frequency.setValueAtTime(f * mul, at);
          if (st.slide || (prof.slide && category !== 'startup' && category !== 'shutdown')) {
            o.frequency.exponentialRampToValueAtTime(f * mul * Math.pow(2, (st.slide || 5) / 12), at + d);
          }
          const g = ctx.createGain();
          const peak = gain * (type === 'square' ? 0.35 : 1);
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(peak, at + a);
          g.gain.exponentialRampToValueAtTime(0.0001, at + a + d);
          o.connect(g);
          g.connect(out);
          o.start(at);
          o.stop(at + a + d + 0.02);
        }
        end = Math.max(end, (st.at || 0) + a + d);
      }

      // A short filtered noise burst: the "tick" of a key or switch.
      if (pat.tick && prof.noise > 0) {
        const n = ctx.createBufferSource();
        n.buffer = this._noise();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = category === 'typing' ? 3200 + Math.random() * 900 : 2200;
        bp.Q.value = 1.4;
        const g = ctx.createGain();
        const len = prof.noise >= 1 ? 0.035 : 0.018;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.9 * prof.noise + 0.1, t0 + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
        n.connect(bp);
        bp.connect(g);
        g.connect(out);
        n.start(t0, Math.random() * 0.2);
        n.stop(t0 + len + 0.01);
        if (prof.noise >= 1) {
          // and the low "thock" of the key bottoming out
          const th = ctx.createOscillator();
          th.type = 'sine';
          th.frequency.setValueAtTime(category === 'typing' ? 170 + Math.random() * 40 : 240, t0);
          th.frequency.exponentialRampToValueAtTime(90, t0 + 0.04);
          const tg = ctx.createGain();
          tg.gain.setValueAtTime(0.0001, t0);
          tg.gain.exponentialRampToValueAtTime(0.5, t0 + 0.003);
          tg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
          th.connect(tg);
          tg.connect(out);
          th.start(t0);
          th.stop(t0 + 0.06);
        }
        end = Math.max(end, len);
      }
      this._voice(end);
    }
  }

  root.VexaSoundEngine = SoundEngine;
  root.VexaSoundEngine.CATEGORIES = CATEGORIES;
  root.VexaSoundEngine.PROFILES = PROFILES;
  root.VexaSoundEngine.MAX_CUSTOM_SECONDS = MAX_CUSTOM_SECONDS;
})(typeof window !== 'undefined' ? window : globalThis);

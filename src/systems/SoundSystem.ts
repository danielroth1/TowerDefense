// ─── Procedural Sound System (Web Audio API) ─────────────────────────────
// All sounds are generated algorithmically – no audio files needed.

export type SFXType =
  | 'shoot_arrow' | 'shoot_cannon' | 'shoot_ice' | 'shoot_lightning'
  | 'shoot_poison' | 'shoot_boomerang'
  | 'enemy_die' | 'boss_die'
  | 'ability_freeze' | 'ability_meteor' | 'ability_lightning' | 'ability_rift'
  | 'tower_place' | 'button_click' | 'wave_start'
  | 'hero_attack' | 'hero_die'
  | 'enemy_leak' | 'game_lose' | 'game_win';

export class SoundSystem {
  static readonly instance = new SoundSystem();

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private bgmNodes: AudioNode[] = [];
  

  sfxEnabled  = true;
  musicEnabled = true;

  /** Call once from a user-gesture handler (pointerdown etc.) */
  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.7;
      this.masterGain.connect(this.ctx.destination);

      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = 0.12;
      this.bgmGain.connect(this.masterGain);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 0.75;
      this.sfxGain.connect(this.masterGain);

      this.startBGM();
    } catch (_e) {
      console.warn('Web Audio API unavailable');
    }
  }

  // ─── SFX ──────────────────────────────────────────────────────────────────
  play(type: SFXType) {
    if (!this.sfxEnabled || !this.ctx || !this.sfxGain) return;
    const c = this.ctx, t = c.currentTime;
    switch (type) {
      // Tower shots
      case 'shoot_arrow':      this.tone(c, t, 680, 420, 'triangle', 0.10, 0.07); break;
      case 'shoot_cannon':
        this.noise(c, t, 0.18, 0.22);
        this.tone(c, t, 110, 45, 'sawtooth', 0.22, 0.28); break;
      case 'shoot_ice':        this.tone(c, t, 1500, 900, 'triangle', 0.08, 0.11); break;
      case 'shoot_lightning':
        this.noise(c, t, 0.14, 0.06);
        this.tone(c, t, 900, 450, 'square', 0.09, 0.06); break;
      case 'shoot_poison':     this.tone(c, t, 360, 200, 'sine',  0.10, 0.14); break;
      case 'shoot_boomerang':  this.tone(c, t, 480, 720, 'square', 0.08, 0.11); break;
      // Deaths
      case 'enemy_die':
        this.noise(c, t, 0.22, 0.14);
        this.tone(c, t, 380, 90, 'sawtooth', 0.14, 0.11); break;
      case 'boss_die':
        this.noise(c, t, 0.55, 0.55);
        this.tone(c, t, 180, 40, 'sawtooth', 0.38, 0.5); break;
      // Abilities
      case 'ability_freeze':
        this.tone(c, t, 1200, 600, 'triangle', 0.15, 0.35);
        this.tone(c, t, 900,  400, 'triangle', 0.10, 0.4); break;
      case 'ability_meteor':
        this.noise(c, t, 0.1, 0.8);
        this.tone(c, t, 200, 80, 'sawtooth', 0.30, 0.55);
        this.chord(c, t, [260, 330, 390], 0.10, 0.4); break;
      case 'ability_lightning':
        this.noise(c, t, 0.22, 0.12);
        this.chord(c, t, [440, 880, 1320], 0.10, 0.3); break;
      case 'ability_rift':
        this.chord(c, t, [220, 277, 330, 440], 0.08, 0.6);
        this.tone(c, t, 110, 55, 'sine', 0.12, 0.8); break;
      // Misc
      case 'tower_place':
        this.tone(c, t, 240, 190, 'sine',  0.28, 0.18);
        this.tone(c, t, 480, 380, 'triangle', 0.10, 0.12); break;
      case 'button_click':     this.tone(c, t, 820, 720, 'sine', 0.09, 0.04); break;
      case 'wave_start':
        [260, 330, 392, 523].forEach((f, i) =>
          this.tone(c, t + i * 0.09, f, f * 1.01, 'triangle', 0.14, 0.22)); break;
      case 'hero_attack':
        this.tone(c, t, 540, 280, 'sawtooth', 0.14, 0.09); break;
      case 'hero_die':
        this.noise(c, t, 0.32, 0.45);
        this.tone(c, t, 300, 60, 'sawtooth', 0.22, 0.5); break;
      case 'enemy_leak':
        // Alarm-like descending tone
        this.tone(c, t, 880, 220, 'square', 0.18, 0.30);
        this.noise(c, t + 0.05, 0.12, 0.18); break;
      case 'game_lose':
        // Sad descending minor chord
        this.chord(c, t, [330, 392, 494], 0.18, 0.6);
        this.chord(c, t + 0.5, [262, 311, 392], 0.14, 0.7);
        this.tone(c, t + 0.8, 196, 65, 'sawtooth', 0.20, 1.0); break;
      case 'game_win':
        // Triumphant ascending arpeggio
        [392, 494, 588, 784].forEach((f, i) =>
          this.tone(c, t + i * 0.12, f, f * 1.005, 'triangle', 0.16, 0.35));
        this.chord(c, t + 0.7, [392, 494, 588, 784], 0.12, 0.8); break;
    }
  }

  // ─── BGM ──────────────────────────────────────────────────────────────────
  private startBGM() {
    if (!this.ctx || !this.bgmGain) return;
    const c = this.ctx;

    // Bass sawtooth drone through heavy low-pass
    const bass = c.createOscillator();
    bass.type = 'sawtooth';
    bass.frequency.value = 55;
    const bassFilter = c.createBiquadFilter();
    bassFilter.type = 'lowpass';
    bassFilter.frequency.value = 140;
    bassFilter.Q.value = 1.5;
    const bassGain = c.createGain();
    bassGain.gain.value = 0.38;
    bass.connect(bassFilter).connect(bassGain).connect(this.bgmGain);
    bass.start();

    // LFO modulates the filter cutoff for a "breathing" effect
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 90;
    lfo.connect(lfoGain).connect(bassFilter.frequency);
    lfo.start();

    // Pad chords (A minor): A2, C3, E3, A3
    const padNotes = [110, 130.8, 164.8, 220];
    for (const freq of padNotes) {
      const pad = c.createOscillator();
      pad.type = 'triangle';
      pad.frequency.value = freq;
      pad.detune.value = (Math.random() - 0.5) * 10;
      const pg = c.createGain();
      pg.gain.value = 0.055;
      pad.connect(pg).connect(this.bgmGain);
      pad.start();
      this.bgmNodes.push(pad, pg);
    }

    // Arpeggio: pentatonic A minor
    const arpPitch = [220, 261.6, 293.7, 329.6, 392.0, 440, 523.3, 392.0];
    let arpStep = 0;
    setInterval(() => {
      if (!this.ctx || !this.bgmGain || !this.musicEnabled) return;
      const t2 = this.ctx.currentTime;
      this.tone(c, t2, arpPitch[arpStep], arpPitch[arpStep] * 0.99, 'triangle', 0.038, 0.22);
      arpStep = (arpStep + 1) % arpPitch.length;
    }, 350);

    this.bgmNodes.push(bass, bassFilter, bassGain, lfo, lfoGain);
  }

  // ─── Toggles ──────────────────────────────────────────────────────────────
  toggleSFX() {
    this.sfxEnabled = !this.sfxEnabled;
    return this.sfxEnabled;
  }

  toggleMusic() {
    this.musicEnabled = !this.musicEnabled;
    if (this.bgmGain) this.bgmGain.gain.value = this.musicEnabled ? 0.12 : 0;
    return this.musicEnabled;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────
  private tone(
    c: AudioContext, t: number,
    f0: number, f1: number,
    type: OscillatorType, amp: number, dur: number,
  ) {
    const osc  = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    gain.gain.setValueAtTime(amp, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.sfxGain!);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  private chord(c: AudioContext, t: number, freqs: number[], amp: number, dur: number) {
    for (const f of freqs) this.tone(c, t, f * 0.97, f, 'triangle', amp, dur);
  }

  private noise(c: AudioContext, t: number, amp: number, dur: number) {
    const n    = Math.ceil(c.sampleRate * dur);
    const buf  = c.createBuffer(1, n, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    const src  = c.createBufferSource();
    src.buffer = buf;
    const gain = c.createGain();
    gain.gain.setValueAtTime(amp, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(gain).connect(this.sfxGain!);
    src.start(t);
  }
}

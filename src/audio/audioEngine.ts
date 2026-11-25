import { sampleAtmosphere } from '../simulation/atmosphere';
import { RocketFlightDynamics } from '../simulation/flightDynamics';
import { Vec3d, distVec3 } from '../math/vec3d';

/**
 * Procedural Web Audio API aerospace sound engine.
 *
 * Synthesizes realistic, atmospheric- and distance-attenuated soundscapes without
 * external copyrighted audio dependencies:
 * - Rocket engine rumble + supersonic crackle modulated by throttle, distance & air pressure
 * - Engine ignition boom & TEA-TEB burst
 * - Engine shutdown pneumatic thump
 * - Stage / fairing / payload separation pyrotechnic snap & cold-gas hiss
 * - Cape Canaveral launchpad coastal ambience & cryogenic LOX vent hiss
 * - Touchdown impact thud & crash explosion rumble
 * - Subtle mission-control UI clicks
 * - Optional onboard cabin audio mode during vacuum spaceflight
 */
export class AerospaceAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private crackleGain: GainNode | null = null;
  private ambienceGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  public masterVolume = 0.65;
  public muted = false;
  /** When true, retains muffled onboard structural engine vibration in space vacuum */
  public onboardSpaceAudio = true;

  private initialized = false;

  public bindUnlock(): void {
    const unlock = () => {
      this.ensureInitialized();
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    try {
      const ctx = new AudioCtx();
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : this.masterVolume;
      master.connect(ctx.destination);
      this.masterGain = master;

      // Create 3-second looped brown/pink noise buffer for realistic rocket roar & wind
      const sr = ctx.sampleRate;
      const len = sr * 3;
      const buf = ctx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.992 * b0 + white * 0.055;
        b1 = 0.96 * b1 + white * 0.14;
        b2 = 0.65 * b2 + white * 0.35;
        data[i] = Math.max(-1, Math.min(1, (b0 + b1 * 0.55 + b2 * 0.25) * 1.4));
      }
      this.noiseBuffer = buf;

      // 1. Continuous deep rocket engine rumble loop
      const engSrc = ctx.createBufferSource();
      engSrc.buffer = buf;
      engSrc.loop = true;

      const engFilter = ctx.createBiquadFilter();
      engFilter.type = 'lowpass';
      engFilter.frequency.value = 180;
      engFilter.Q.value = 1.4;

      const engGain = ctx.createGain();
      engGain.gain.value = 0;

      engSrc.connect(engFilter);
      engFilter.connect(engGain);
      engGain.connect(master);
      engSrc.start();

      this.engineFilter = engFilter;
      this.engineGain = engGain;

      // 2. High-energy supersonic exhaust crackle layer (bandpass around 900 Hz)
      const crkSrc = ctx.createBufferSource();
      crkSrc.buffer = buf;
      crkSrc.loop = true;
      crkSrc.playbackRate.value = 1.35;

      const crkFilter = ctx.createBiquadFilter();
      crkFilter.type = 'bandpass';
      crkFilter.frequency.value = 880;
      crkFilter.Q.value = 0.8;

      const crkGain = ctx.createGain();
      crkGain.gain.value = 0;

      crkSrc.connect(crkFilter);
      crkFilter.connect(crkGain);
      crkGain.connect(master);
      crkSrc.start();
      this.crackleGain = crkGain;

      // 3. Subtle Cape Canaveral launchpad coastal breeze + LOX cryogenic vent hiss
      const ambSrc = ctx.createBufferSource();
      ambSrc.buffer = buf;
      ambSrc.loop = true;
      ambSrc.playbackRate.value = 0.65;

      const ambFilter = ctx.createBiquadFilter();
      ambFilter.type = 'bandpass';
      ambFilter.frequency.value = 520;
      ambFilter.Q.value = 0.5;

      const ambGain = ctx.createGain();
      ambGain.gain.value = 0;

      ambSrc.connect(ambFilter);
      ambFilter.connect(ambGain);
      ambGain.connect(master);
      ambSrc.start();
      this.ambienceGain = ambGain;

      this.initialized = true;
    } catch {
      // Ignore audio initialization failures in headless / restricted environments
    }
  }

  public setMasterVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(
        this.muted ? 0 : this.masterVolume,
        this.ctx.currentTime,
        0.04
      );
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(
        this.muted ? 0 : this.masterVolume,
        this.ctx.currentTime,
        0.04
      );
    }
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public toggleOnboardSpaceAudio(): boolean {
    this.onboardSpaceAudio = !this.onboardSpaceAudio;
    return this.onboardSpaceAudio;
  }

  public update(
    activeRocket: RocketFlightDynamics,
    cameraPosECEF: Vec3d,
    paused: boolean,
    inMapView: boolean
  ): void {
    if (!this.initialized || !this.ctx || !this.engineGain || !this.engineFilter || !this.crackleGain || !this.ambienceGain) {
      return;
    }

    const now = this.ctx.currentTime;
    if (paused || inMapView) {
      this.engineGain.gain.setTargetAtTime(0, now, 0.08);
      this.crackleGain.gain.setTargetAtTime(0, now, 0.08);
      this.ambienceGain.gain.setTargetAtTime(0, now, 0.12);
      return;
    }

    const altASL = Math.max(0, activeRocket.getAltitudeASL());
    const atmo = sampleAtmosphere(altASL);
    const pRatio = atmo.pressureRatio;
    const camDistM = distVec3(activeRocket.posECEF, cameraPosECEF);
    const distAtten = 1 / (1 + camDistM / 220);

    const thr = activeRocket.actualThrottle;
    const thrustClass = Math.pow(Math.max(0.01, activeRocket.config.maxThrustVacN / 8_227_000), 0.35);

    // Atmospheric external sound drops smoothly toward zero in vacuum; optional onboard structural vibration stays subtle
    const atmoTransmission = Math.pow(pRatio, 0.45);
    const vacuumFloor = this.onboardSpaceAudio ? 0.22 : 0.0;
    const mediumFactor = Math.max(atmoTransmission, vacuumFloor);

    const rumbleLevel = thr * thrustClass * distAtten * mediumFactor * 0.55;
    const crackleLevel = thr * thrustClass * distAtten * atmoTransmission * 0.24;

    // Low-pass cutoff drops smoothly in vacuum (muffled hull vibration) & at distance
    const cutoffHz = 95 + (140 + thr * 420) * atmoTransmission * (0.4 + 0.6 * distAtten);

    this.engineGain.gain.setTargetAtTime(rumbleLevel, now, 0.06);
    this.engineFilter.frequency.setTargetAtTime(cutoffHz, now, 0.08);
    this.crackleGain.gain.setTargetAtTime(crackleLevel, now, 0.06);

    // Coastal pad ambience & LOX hiss when near Cape Canaveral surface
    const padFactor = Math.max(0, 1 - altASL / 1500) * distAtten;
    this.ambienceGain.gain.setTargetAtTime(padFactor * 0.055, now, 0.15);
  }

  public playIgnition(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    // Deep sub-bass ignition boom
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(92, now);
    osc.frequency.exponentialRampToValueAtTime(28, now + 0.48);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.42, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.58);
  }

  public playShutdown(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.24);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.18, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.26);

    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.28);
  }

  public playStageSeparation(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    // Metallic clamp release snap
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.exponentialRampToValueAtTime(72, now + 0.12);

    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.16, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

    osc.connect(og);
    og.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.16);

    // Pneumatic cold-gas pusher hiss
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.value = 1800;

    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.22, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

    src.connect(filt);
    filt.connect(ng);
    ng.connect(this.masterGain);
    src.start(now);
    src.stop(now + 0.6);
  }

  public playTouchdown(): void {
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(115, now);
    osc.frequency.exponentialRampToValueAtTime(32, now + 0.22);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.32, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.26);
  }

  public playCrash(): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(720, now);
    filt.frequency.exponentialRampToValueAtTime(65, now + 1.4);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.65, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 1.6);

    src.connect(filt);
    filt.connect(g);
    g.connect(this.masterGain);
    src.start(now);
    src.stop(now + 1.65);
  }

  public playUiClick(): void {
    this.ensureInitialized();
    if (!this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(920, now);
    osc.frequency.exponentialRampToValueAtTime(640, now + 0.035);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.045, now);
    g.gain.exponentialRampToValueAtTime(0.0008, now + 0.04);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.045);
  }
}

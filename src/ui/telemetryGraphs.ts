import { SpacecraftRecording, TelemetrySample } from '../flightComputer/flightRecorder';

interface ChannelDef {
  key: string;
  label: string;
  unit: string;
  color: string;
  getValue: (s: TelemetrySample) => number | null;
}

const BASE_CHANNELS: ChannelDef[] = [
  { key: 'altitudeKm', label: 'Altitude ASL', unit: 'km', color: '#4cc9ff', getValue: (s) => s.altitudeKm },
  { key: 'surfaceSpeedMs', label: 'Surface Vel', unit: 'm/s', color: '#38d98a', getValue: (s) => s.surfaceSpeedMs },
  { key: 'inertialSpeedMs', label: 'Inertial Vel', unit: 'm/s', color: '#7da8ff', getValue: (s) => s.inertialSpeedMs },
  { key: 'verticalSpeedMs', label: 'Vertical Vel', unit: 'm/s', color: '#b48bff', getValue: (s) => s.verticalSpeedMs },
  { key: 'gForce', label: 'Accel (G)', unit: 'G', color: '#f5a638', getValue: (s) => s.gForce },
  { key: 'throttlePct', label: 'Throttle', unit: '%', color: '#ff7d47', getValue: (s) => s.throttlePct },
  { key: 'fuelPct', label: 'Fuel', unit: '%', color: '#5bc2ff', getValue: (s) => s.fuelPct },
  { key: 'pitchDeg', label: 'Pitch', unit: '°', color: '#e6d865', getValue: (s) => s.pitchDeg },
  { key: 'angVelDegS', label: 'Ang Vel', unit: '°/s', color: '#ff6ba6', getValue: (s) => s.angVelDegS },
  { key: 'reentryHeat', label: 'Reentry Heat', unit: '%', color: '#ff4f4f', getValue: (s) => s.reentryHeat },
  { key: 'apoapsisKm', label: 'Apoapsis', unit: 'km', color: '#34e8d8', getValue: (s) => s.apoapsisKm },
  { key: 'execTimeMs', label: 'FC Exec Time', unit: 'ms', color: '#d0d9e6', getValue: (s) => s.execTimeMs },
];

const CUSTOM_PALETTE = ['#ff9cf2', '#8fff7a', '#ffdd6b', '#69e5ff'];

/**
 * Interactive zoomable Canvas2D flight telemetry graph viewer with multi-channel
 * comparison, hover sample inspection, and flight event markers.
 */
export class TelemetryGraphView {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly channelBar: HTMLElement;
  private readonly readoutEl: HTMLElement;

  private activeKeys = new Set<string>(['altitudeKm', 'surfaceSpeedMs', 'throttlePct']);
  private zoomLevel = 1; // 1 = full window, >1 = zoomed in
  private panFraction = 1; // 0 = start, 1 = latest right edge
  private hoverNormX: number | null = null;
  private lastCustomSig = '';

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.innerHTML = `
      <div class="graph-toolbar">
        <div class="graph-channels" id="graph-channels"></div>
        <div class="graph-zoom-group">
          <button class="ws-btn" id="graph-zoom-in" title="Zoom In">+</button>
          <button class="ws-btn" id="graph-zoom-out" title="Zoom Out">&minus;</button>
          <button class="ws-btn" id="graph-zoom-reset" title="Reset View">100%</button>
        </div>
      </div>
      <div class="graph-canvas-wrap">
        <canvas id="graph-canvas"></canvas>
      </div>
      <div class="graph-readout" id="graph-readout">Hover over graph to inspect individual telemetry samples.</div>
    `;

    this.channelBar = container.querySelector('#graph-channels') as HTMLElement;
    this.canvas = container.querySelector('#graph-canvas') as HTMLCanvasElement;
    this.ctx = this.canvas.getContext('2d')!;
    this.readoutEl = container.querySelector('#graph-readout') as HTMLElement;

    container.querySelector('#graph-zoom-in')!.addEventListener('click', () => {
      this.zoomLevel = Math.min(20, this.zoomLevel * 1.6);
    });
    container.querySelector('#graph-zoom-out')!.addEventListener('click', () => {
      this.zoomLevel = Math.max(1, this.zoomLevel / 1.6);
    });
    container.querySelector('#graph-zoom-reset')!.addEventListener('click', () => {
      this.zoomLevel = 1;
      this.panFraction = 1;
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) this.zoomLevel = Math.min(20, this.zoomLevel * 1.25);
      else this.zoomLevel = Math.max(1, this.zoomLevel / 1.25);
    }, { passive: false });

    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.hoverNormX = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      if (e.buttons === 1 && this.zoomLevel > 1) {
        this.panFraction = Math.max(0, Math.min(1, this.panFraction - e.movementX / Math.max(100, rect.width)));
      }
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverNormX = null;
    });

    this.rebuildChannelChips([]);
  }

  private getAllChannels(customKeys: string[]): ChannelDef[] {
    const customDefs: ChannelDef[] = customKeys.map((k, i) => ({
      key: `custom:${k}`,
      label: `var:${k}`,
      unit: '',
      color: CUSTOM_PALETTE[i % CUSTOM_PALETTE.length],
      getValue: (s) => (s.custom[k] !== undefined ? s.custom[k] : null),
    }));
    return [...BASE_CHANNELS, ...customDefs];
  }

  private rebuildChannelChips(customKeys: string[]): void {
    const sig = customKeys.join(',');
    if (sig === this.lastCustomSig && this.channelBar.children.length > 0) return;
    this.lastCustomSig = sig;

    const all = this.getAllChannels(customKeys);
    this.channelBar.innerHTML = '';
    for (const ch of all) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `chan-chip${this.activeKeys.has(ch.key) ? ' active' : ''}`;
      btn.innerHTML = `<span class="chan-dot" style="background:${ch.color}"></span>${ch.label}`;
      btn.addEventListener('click', () => {
        if (this.activeKeys.has(ch.key)) {
          if (this.activeKeys.size > 1) this.activeKeys.delete(ch.key);
        } else {
          this.activeKeys.add(ch.key);
        }
        btn.classList.toggle('active', this.activeKeys.has(ch.key));
      });
      this.channelBar.appendChild(btn);
    }
  }

  public render(rec: SpacecraftRecording): void {
    const customKeys = [...rec.customKeys];
    this.rebuildChannelChips(customKeys);

    const wrap = this.canvas.parentElement!;
    const w = Math.max(240, wrap.clientWidth);
    const h = Math.max(150, wrap.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // Background grid
    ctx.fillStyle = '#090e18';
    ctx.fillRect(0, 0, w, h);

    const padL = 10;
    const padR = 10;
    const padT = 16;
    const padB = 22;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    ctx.strokeStyle = 'rgba(130, 160, 200, 0.14)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
    }

    const samples = rec.samples;
    if (samples.length < 2) {
      ctx.fillStyle = '#8094b0';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillText('Recording live telemetry samples… launch or unpause simulation.', padL + 8, h / 2);
      ctx.restore();
      return;
    }

    const tMinAll = samples[0].simTime;
    const tMaxAll = samples[samples.length - 1].simTime;
    const totalSpan = Math.max(1, tMaxAll - tMinAll);
    const viewSpan = totalSpan / this.zoomLevel;
    const tStart = tMinAll + (totalSpan - viewSpan) * this.panFraction;
    const tEnd = tStart + viewSpan;

    const visible = samples.filter((s) => s.simTime >= tStart && s.simTime <= tEnd);
    if (visible.length < 2) {
      ctx.restore();
      return;
    }

    const xOf = (t: number) => padL + ((t - tStart) / Math.max(0.001, viewSpan)) * plotW;

    // Draw flight event markers (staging, ignition, shutdown, touchdown, fault)
    ctx.font = '600 9px "JetBrains Mono", monospace';
    for (const ev of rec.events) {
      if (ev.simTime < tStart || ev.simTime > tEnd) continue;
      const ex = xOf(ev.simTime);
      const col =
        ev.kind === 'fault' ? '#f25555' : ev.kind === 'staging' ? '#38d98a' : '#f5a638';
      ctx.strokeStyle = col;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(ex, padT);
      ctx.lineTo(ex, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.fillText(ev.label, ex + 3, padT + 10);
    }

    // Plot each selected channel auto-normalized to its visible range so heterogeneous units compare cleanly
    const activeChannels = this.getAllChannels(customKeys).filter((c) => this.activeKeys.has(c.key));
    for (const ch of activeChannels) {
      let minV = Infinity;
      let maxV = -Infinity;
      for (const s of visible) {
        const v = ch.getValue(s);
        if (v !== null && Number.isFinite(v)) {
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
      if (!Number.isFinite(minV)) continue;
      if (Math.abs(maxV - minV) < 1e-4) {
        minV -= 1;
        maxV += 1;
      }

      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (const s of visible) {
        const v = ch.getValue(s);
        if (v === null || !Number.isFinite(v)) {
          started = false;
          continue;
        }
        const x = xOf(s.simTime);
        const y = padT + plotH - ((v - minV) / (maxV - minV)) * plotH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // Time axis labels
    ctx.fillStyle = '#8b9cb5';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillText(`${tStart.toFixed(1)}s`, padL, h - 6);
    const endLbl = `${tEnd.toFixed(1)}s (${visible.length} pts)`;
    ctx.fillText(endLbl, w - padR - ctx.measureText(endLbl).width, h - 6);

    // Hover scrubber line & exact readout
    if (this.hoverNormX !== null) {
      const hoverT = tStart + this.hoverNormX * viewSpan;
      let nearest = visible[0];
      let bestDist = Infinity;
      for (const s of visible) {
        const d = Math.abs(s.simTime - hoverT);
        if (d < bestDist) {
          bestDist = d;
          nearest = s;
        }
      }
      const hx = xOf(nearest.simTime);
      ctx.strokeStyle = 'rgba(232, 239, 249, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();

      const parts = [`T=${nearest.simTime.toFixed(1)}s (MET ${nearest.met.toFixed(1)}s)`];
      for (const ch of activeChannels) {
        const v = ch.getValue(nearest);
        parts.push(`${ch.label}: ${v !== null ? v.toFixed(2) : '—'}${ch.unit}`);
      }
      this.readoutEl.textContent = parts.join('  |  ');
    }

    ctx.restore();
  }
}

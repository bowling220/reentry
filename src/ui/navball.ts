import { TelemetrySnapshot } from '../simulation/telemetry';
import { DEG2RAD } from '../math/vec3d';

/**
 * Compact, high-contrast Canvas2D Aerospace Navball / Attitude Indicator.
 * Displays artificial horizon (sky vs ground hemisphere), pitch ladder,
 * roll bank, compass heading, and velocity prograde vector marker.
 */
export class NavballRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly size: number;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = 148;
    canvas.width = this.size * dpr;
    canvas.height = this.size * dpr;
    canvas.style.width = `${this.size}px`;
    canvas.style.height = `${this.size}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    this.ctx = ctx;
  }

  public render(t: TelemetrySnapshot): void {
    const ctx = this.ctx;
    const s = this.size;
    const cx = s / 2;
    const cy = s / 2;
    const r = s / 2 - 6;

    ctx.clearRect(0, 0, s, s);

    ctx.save();
    // Clip to circular navball aperture
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();

    // Rotate sphere by vehicle roll around center
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-t.rollDeg * DEG2RAD);

    // Pitch displacement: +90 deg (vertical up) shifts horizon to bottom edge; 0 deg centers horizon
    const pxPerDeg = r / 68;
    const horizonY = t.pitchDeg * pxPerDeg;

    // Sky hemisphere (deep aerospace cobalt)
    const skyGrad = ctx.createLinearGradient(0, -r * 2, 0, horizonY);
    skyGrad.addColorStop(0, '#0d2647');
    skyGrad.addColorStop(1, '#1f5a99');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(-r * 2, -r * 2, r * 4, horizonY + r * 2);

    // Ground hemisphere (earthy umber/slate)
    const gndGrad = ctx.createLinearGradient(0, horizonY, 0, r * 2);
    gndGrad.addColorStop(0, '#6a4a33');
    gndGrad.addColorStop(1, '#2b1d14');
    ctx.fillStyle = gndGrad;
    ctx.fillRect(-r * 2, horizonY, r * 4, r * 3);

    // Crisp artificial horizon line
    ctx.strokeStyle = '#e5eef8';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-r * 2, horizonY);
    ctx.lineTo(r * 2, horizonY);
    ctx.stroke();

    // Pitch ladder ticks every 15 degrees
    ctx.strokeStyle = 'rgba(229, 238, 248, 0.55)';
    ctx.fillStyle = 'rgba(229, 238, 248, 0.78)';
    ctx.font = '600 9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let deg = -60; deg <= 90; deg += 15) {
      if (deg === 0) continue;
      const y = horizonY - deg * pxPerDeg;
      if (Math.abs(y) > r + 14) continue;
      const halfW = deg % 30 === 0 ? 22 : 11;
      ctx.lineWidth = deg % 30 === 0 ? 1.2 : 0.9;
      ctx.beginPath();
      ctx.moveTo(-halfW, y);
      ctx.lineTo(halfW, y);
      ctx.stroke();
      if (deg % 30 === 0 && deg !== 90) {
        ctx.fillText(`${deg}`, halfW + 12, y);
      }
    }

    // Zenith marker (+90° dot)
    const zenithY = horizonY - 90 * pxPerDeg;
    if (Math.abs(zenithY) < r) {
      ctx.strokeStyle = '#60c3ff';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(0, zenithY, 4.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();

    // Prograde velocity marker (green circle with fins) when moving > 2 m/s
    if (t.totalVelocityMs > 2.0) {
      const proPitch = Math.asin(Math.max(-1, Math.min(1, t.progradeLocal.y))) * (180 / Math.PI);
      let proHdg = Math.atan2(t.progradeLocal.x, -t.progradeLocal.z) * (180 / Math.PI);
      if (proHdg < 0) proHdg += 360;

      let dHdg = proHdg - t.yawHeadingDeg;
      while (dHdg > 180) dHdg -= 360;
      while (dHdg < -180) dHdg += 360;

      const dPitch = proPitch - t.pitchDeg;
      const mx = cx + Math.max(-r + 12, Math.min(r - 12, dHdg * 0.9));
      const my = cy - Math.max(-r + 12, Math.min(r - 12, dPitch * pxPerDeg));

      ctx.strokeStyle = '#3ef08a';
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.arc(mx, my, 5.5, 0, Math.PI * 2);
      ctx.moveTo(mx - 10, my);
      ctx.lineTo(mx - 5.5, my);
      ctx.moveTo(mx + 5.5, my);
      ctx.lineTo(mx + 10, my);
      ctx.moveTo(mx, my - 5.5);
      ctx.lineTo(mx, my - 9.5);
      ctx.stroke();
    }

    // Subtle glass inner shadow
    const vignette = ctx.createRadialGradient(cx, cy, r * 0.58, cx, cy, r);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(4, 8, 16, 0.58)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, s, s);

    ctx.restore();

    // Fixed center aircraft/rocket level-wings reticle (amber-gold)
    ctx.strokeStyle = '#ffb443';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(cx - 20, cy);
    ctx.lineTo(cx - 7, cy);
    ctx.lineTo(cx - 4, cy + 4);
    ctx.moveTo(cx + 20, cy);
    ctx.lineTo(cx + 7, cy);
    ctx.lineTo(cx + 4, cy + 4);
    ctx.stroke();

    ctx.fillStyle = '#ffb443';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
    ctx.fill();

    // Outer metallic bezel ring
    ctx.strokeStyle = 'rgba(148, 174, 206, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Compass heading pill at bottom of bezel
    const hdgStr = `${Math.round(t.yawHeadingDeg).toString().padStart(3, '0')}°`;
    ctx.fillStyle = 'rgba(10, 14, 22, 0.92)';
    ctx.strokeStyle = 'rgba(148, 174, 206, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(cx - 22, s - 19, 44, 15, 3);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e7effa';
    ctx.font = '600 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(hdgStr, cx, s - 11.5);
  }
}

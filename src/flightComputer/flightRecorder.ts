import { VirtualFlightComputer } from './flightComputer';
import { SpacecraftEntity } from '../simulation/spacecraftManager';
import { TelemetrySnapshot } from '../simulation/telemetry';

export interface TelemetrySample {
  simTime: number;
  met: number;
  altitudeKm: number;
  altitudeAglM: number;
  surfaceSpeedMs: number;
  inertialSpeedMs: number;
  verticalSpeedMs: number;
  gForce: number;
  throttlePct: number;
  fuelPct: number;
  pitchDeg: number;
  angVelDegS: number;
  reentryHeat: number;
  apoapsisKm: number | null;
  execTimeMs: number;
  custom: Record<string, number>;
}

export interface RecordedEventMarker {
  simTime: number;
  met: number;
  label: string;
  kind: 'ignition' | 'shutdown' | 'staging' | 'touchdown' | 'fault' | 'orbit';
}

export interface SpacecraftRecording {
  spacecraftId: string;
  samples: TelemetrySample[];
  events: RecordedEventMarker[];
  customKeys: Set<string>;
}

/**
 * Bounded per-spacecraft flight data recorder supporting configurable sampling frequency,
 * event markers, and CSV / JSON telemetry export.
 */
export class FlightDataRecorder {
  public sampleHz = 2; // Configurable: 1, 2, 5, 10 Hz
  public enabled = true;

  private readonly recordings = new Map<string, SpacecraftRecording>();
  private readonly accumulators = new Map<string, number>();
  private static readonly MAX_SAMPLES_PER_CRAFT = 2400;
  private static readonly MAX_EVENTS_PER_CRAFT = 120;

  public reset(): void {
    this.recordings.clear();
    this.accumulators.clear();
  }

  public clearCraft(spacecraftId: string): void {
    this.recordings.delete(spacecraftId);
    this.accumulators.delete(spacecraftId);
  }

  public getRecording(spacecraftId: string): SpacecraftRecording {
    let rec = this.recordings.get(spacecraftId);
    if (!rec) {
      rec = {
        spacecraftId,
        samples: [],
        events: [],
        customKeys: new Set<string>(),
      };
      this.recordings.set(spacecraftId, rec);
    }
    return rec;
  }

  public recordEvent(
    spacecraftId: string,
    simTime: number,
    met: number,
    label: string,
    kind: RecordedEventMarker['kind']
  ): void {
    const rec = this.getRecording(spacecraftId);
    rec.events.push({ simTime, met, label, kind });
    if (rec.events.length > FlightDataRecorder.MAX_EVENTS_PER_CRAFT) {
      rec.events.shift();
    }
  }

  public stepRecord(
    dt: number,
    simTime: number,
    craft: SpacecraftEntity,
    telemetry: TelemetrySnapshot,
    computer: VirtualFlightComputer
  ): void {
    if (!this.enabled) return;

    const period = 1 / Math.max(0.5, Math.min(20, this.sampleHz));
    const acc = (this.accumulators.get(craft.id) ?? 0) + dt;
    if (acc < period) {
      this.accumulators.set(craft.id, acc);
      return;
    }
    this.accumulators.set(craft.id, acc % period);

    const rec = this.getRecording(craft.id);
    const dyn = craft.dynamics;
    const angVelMag =
      Math.hypot(dyn.angVelBody.x, dyn.angVelBody.y, dyn.angVelBody.z) * (180 / Math.PI);

    const custom: Record<string, number> = {};
    for (const [k, v] of Object.entries(computer.customVariables)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        custom[k] = v;
        rec.customKeys.add(k);
      }
    }

    const sample: TelemetrySample = {
      simTime,
      met: telemetry.missionElapsedTimeS,
      altitudeKm: telemetry.altitudeASLM / 1000,
      altitudeAglM: telemetry.altitudeAGLM,
      surfaceSpeedMs: telemetry.totalVelocityMs,
      inertialSpeedMs: telemetry.inertialVelocityMs,
      verticalSpeedMs: telemetry.verticalVelocityMs,
      gForce: telemetry.gForce,
      throttlePct: telemetry.throttlePercent,
      fuelPct: telemetry.fuelPercent,
      pitchDeg: telemetry.pitchDeg,
      angVelDegS: angVelMag,
      reentryHeat: telemetry.reentryHeatIntensity * 100,
      apoapsisKm:
        telemetry.orbital.apoapsisAltM !== null
          ? telemetry.orbital.apoapsisAltM / 1000
          : null,
      execTimeMs: computer.stats.lastExecMs,
      custom,
    };

    rec.samples.push(sample);
    if (rec.samples.length > FlightDataRecorder.MAX_SAMPLES_PER_CRAFT) {
      rec.samples.shift();
    }
  }

  public exportCsv(spacecraftId: string, craftName: string): void {
    const rec = this.getRecording(spacecraftId);
    const customCols = [...rec.customKeys];
    const header = [
      'simTime_s',
      'met_s',
      'altitude_km',
      'altitude_agl_m',
      'surface_vel_ms',
      'inertial_vel_ms',
      'vertical_vel_ms',
      'g_force',
      'throttle_pct',
      'fuel_pct',
      'pitch_deg',
      'ang_vel_degs',
      'reentry_heat_pct',
      'apoapsis_km',
      'fc_exec_ms',
      ...customCols.map((k) => `custom_${k}`),
    ];

    const rows = [header.join(',')];
    for (const s of rec.samples) {
      const vals = [
        s.simTime.toFixed(2),
        s.met.toFixed(2),
        s.altitudeKm.toFixed(4),
        s.altitudeAglM.toFixed(2),
        s.surfaceSpeedMs.toFixed(2),
        s.inertialSpeedMs.toFixed(2),
        s.verticalSpeedMs.toFixed(2),
        s.gForce.toFixed(3),
        s.throttlePct.toFixed(1),
        s.fuelPct.toFixed(2),
        s.pitchDeg.toFixed(2),
        s.angVelDegS.toFixed(2),
        s.reentryHeat.toFixed(1),
        s.apoapsisKm !== null ? s.apoapsisKm.toFixed(3) : '',
        s.execTimeMs.toFixed(3),
        ...customCols.map((k) => (s.custom[k] !== undefined ? String(s.custom[k]) : '')),
      ];
      rows.push(vals.join(','));
    }

    this.downloadBlob(
      rows.join('\n'),
      'text/csv;charset=utf-8',
      `${craftName.replace(/[^a-z0-9_-]/gi, '_')}_telemetry.csv`
    );
  }

  public exportJson(spacecraftId: string, craftName: string): void {
    const rec = this.getRecording(spacecraftId);
    const payload = {
      spacecraftId,
      spacecraftName: craftName,
      exportedAt: new Date().toISOString(),
      sampleHz: this.sampleHz,
      events: rec.events,
      samples: rec.samples,
    };
    this.downloadBlob(
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
      `${craftName.replace(/[^a-z0-9_-]/gi, '_')}_telemetry.json`
    );
  }

  private downloadBlob(content: string, mime: string, filename: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

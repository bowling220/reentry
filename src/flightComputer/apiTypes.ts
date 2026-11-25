import { SpacecraftRole } from '../config/vehicleConfig';
import { FlightStatus, SasMode } from '../simulation/flightDynamics';
import { TrajectoryClassification } from '../simulation/orbitalMechanics';

export const FLIGHT_API_VERSION = '1.0.0';

export type ProgramLanguage = 'javascript' | 'python';

export type ControlAuthority = 'MANUAL' | 'ASSISTED' | 'PROGRAM' | 'FAULT';

export type ProgramRunState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED' | 'FAULT';

export type FlightEventType =
  | 'liftoff'
  | 'ignition'
  | 'shutdown'
  | 'staging'
  | 'touchdown'
  | 'destroyed'
  | 'orbit_achieved';

/**
 * Plain JSON-serializable, read-only telemetry snapshot exposed to sandboxed
 * REENTRY flight computer programs (versioned v1.0.0).
 */
export interface ReentryTelemetry {
  apiVersion: string;
  simTime: number;
  met: number;
  dt: number;
  vehicle: {
    id: string;
    name: string;
    role: SpacecraftRole;
    status: FlightStatus;
    massKg: number;
    propellantKg: number;
    propellantCapacityKg: number;
    propellantFraction: number;
    hasLandingGear: boolean;
    canStage: boolean;
    nextStageLabel: string;
  };
  position: {
    altitudeASL: number;
    altitudeAGL: number;
    latitudeDeg: number;
    longitudeDeg: number;
    distanceFromPadM: number;
  };
  velocity: {
    vertical: number;
    horizontal: number;
    surfaceSpeed: number;
    inertialSpeed: number;
    mach: number;
    surfaceLocal: { east: number; up: number; south: number };
  };
  attitude: {
    pitchDeg: number;
    headingDeg: number;
    rollDeg: number;
    tiltFromVerticalDeg: number;
    angularVelocityBody: { x: number; y: number; z: number };
  };
  acceleration: {
    feltMs2: number;
    gForce: number;
  };
  propulsion: {
    engineIgnited: boolean;
    throttle: number;
    thrustN: number;
  };
  environment: {
    atmosphericDensity: number;
    dynamicPressurePa: number;
    gravityMs2: number;
    inSpace: boolean;
    reentryHeat: number;
  };
  orbit: {
    valid: boolean;
    classification: TrajectoryClassification;
    apoapsisM: number | null;
    periapsisM: number | null;
    inclinationDeg: number | null;
    eccentricity: number | null;
    periodS: number | null;
    timeToApoapsisS: number | null;
    timeToPeriapsisS: number | null;
  };
  controls: {
    sasMode: SasMode;
    gearDeployed: boolean;
  };
  landingTarget: {
    name: string;
    distanceM: number;
    relativeEastM: number;
    relativeSouthM: number;
    elevationM: number;
  };
}

/**
 * Unvalidated raw control request emitted by a player program during a single update step.
 */
export interface RawProgramCommand {
  throttle?: unknown;
  ignite?: unknown;
  shutdown?: unknown;
  pitch?: unknown;
  yaw?: unknown;
  roll?: unknown;
  sasMode?: unknown;
  deployGear?: unknown;
  stage?: unknown;
  [key: string]: unknown;
}

/**
 * Sanitized, bounded control command ready to feed into the spacecraft flight dynamics.
 */
export interface ValidatedFlightCommand {
  throttle: number | null;
  ignite: boolean;
  shutdown: boolean;
  pitch: number;
  yaw: number;
  roll: number;
  sasMode: SasMode | null;
  deployGear: boolean | null;
  stage: boolean;
}

export interface RejectedCommandInfo {
  field: string;
  reason: string;
  simTime: number;
}

export interface ConsoleEntry {
  simTime: number;
  level: 'log' | 'warn' | 'error' | 'sys';
  message: string;
}

export interface FaultRecord {
  simTime: number;
  message: string;
  line: number | null;
}

export interface RuntimeStats {
  lastExecMs: number;
  avgExecMs: number;
  maxExecMs: number;
  memoryBytes: number | null;
  ticksExecuted: number;
  droppedTicks: number;
}

export interface ProgramStepResult {
  ok: boolean;
  command: RawProgramCommand;
  logs: Array<{ level: 'log' | 'warn' | 'error'; message: string }>;
  customVars: Record<string, number | string | boolean>;
  execTimeMs: number;
  memoryBytes: number | null;
  error?: string;
  line?: number | null;
}

/**
 * Worker message protocol shared identically by the QuickJS-WASM JavaScript worker
 * and the isolated lazy-loaded Python (Pyodide) worker.
 */
export type RuntimeWorkerRequest =
  | {
      type: 'load';
      requestId: number;
      code: string;
      telemetry: ReentryTelemetry;
      timeLimitMs: number;
      memoryLimitBytes: number;
    }
  | {
      type: 'update';
      requestId: number;
      telemetry: ReentryTelemetry;
      timeLimitMs: number;
    }
  | {
      type: 'event';
      requestId: number;
      eventName: FlightEventType;
      payload: Record<string, unknown>;
      telemetry: ReentryTelemetry;
      timeLimitMs: number;
    };

export type RuntimeWorkerResponse =
  | {
      type: 'status';
      message: string;
    }
  | {
      type: 'result';
      requestId: number;
      result: ProgramStepResult;
    };

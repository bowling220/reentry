import { SasMode } from '../simulation/flightDynamics';
import {
  RawProgramCommand,
  RejectedCommandInfo,
  ValidatedFlightCommand,
} from './apiTypes';

const ALLOWED_FIELDS = new Set([
  'throttle',
  'ignite',
  'shutdown',
  'pitch',
  'yaw',
  'roll',
  'sasMode',
  'deployGear',
  'stage',
]);

const VALID_SAS_MODES = new Set<SasMode>(['OFF', 'HOLD', 'RETROGRADE', 'VERTICAL']);

export interface CommandValidationContext {
  simTime: number;
  hasEngine: boolean;
  hasLandingGear: boolean;
  canStage: boolean;
  stageBlockedReason: string | null;
  isDestroyed: boolean;
}

export interface CommandValidationResult {
  command: ValidatedFlightCommand;
  rejections: RejectedCommandInfo[];
  hasAnyCommand: boolean;
}

export function createNeutralCommand(): ValidatedFlightCommand {
  return {
    throttle: null,
    ignite: false,
    shutdown: false,
    pitch: 0,
    yaw: 0,
    roll: 0,
    sasMode: null,
    deployGear: null,
    stage: false,
  };
}

/**
 * Validates and constrains every control request emitted by a sandboxed flight program.
 * Programs can never bypass vehicle physics limits or directly mutate simulation state.
 */
export function validateProgramCommand(
  raw: RawProgramCommand | null | undefined,
  ctx: CommandValidationContext
): CommandValidationResult {
  const cmd = createNeutralCommand();
  const rejections: RejectedCommandInfo[] = [];

  if (!raw || typeof raw !== 'object') {
    return { command: cmd, rejections, hasAnyCommand: false };
  }

  if (ctx.isDestroyed) {
    if (Object.keys(raw).length > 0) {
      rejections.push({
        field: 'vehicle',
        reason: 'Spacecraft is destroyed; all control commands rejected.',
        simTime: ctx.simTime,
      });
    }
    return { command: cmd, rejections, hasAnyCommand: false };
  }

  let hasAnyCommand = false;

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) {
      rejections.push({
        field: key,
        reason: `Unknown or restricted command field "${key}" ignored.`,
        simTime: ctx.simTime,
      });
    }
  }

  // Throttle (0..1)
  if (raw.throttle !== undefined && raw.throttle !== null) {
    if (!ctx.hasEngine) {
      rejections.push({
        field: 'throttle',
        reason: 'Vehicle has no controllable main engine.',
        simTime: ctx.simTime,
      });
    } else if (typeof raw.throttle !== 'number' || !Number.isFinite(raw.throttle)) {
      rejections.push({
        field: 'throttle',
        reason: 'Throttle must be a finite number between 0 and 1.',
        simTime: ctx.simTime,
      });
    } else {
      if (raw.throttle < 0 || raw.throttle > 1) {
        rejections.push({
          field: 'throttle',
          reason: `Throttle ${raw.throttle.toFixed(2)} clamped to [0, 1].`,
          simTime: ctx.simTime,
        });
      }
      cmd.throttle = Math.max(0, Math.min(1, raw.throttle));
      hasAnyCommand = true;
    }
  }

  // Ignition & Shutdown
  const reqIgnite = raw.ignite === true;
  const reqShutdown = raw.shutdown === true;
  if (reqIgnite && reqShutdown) {
    rejections.push({
      field: 'ignite/shutdown',
      reason: 'Conflicting ignite and shutdown requests in same tick; shutdown prioritized.',
      simTime: ctx.simTime,
    });
    cmd.shutdown = true;
    cmd.throttle = 0;
    hasAnyCommand = true;
  } else if (reqShutdown) {
    cmd.shutdown = true;
    cmd.throttle = 0;
    hasAnyCommand = true;
  } else if (reqIgnite) {
    if (!ctx.hasEngine) {
      rejections.push({
        field: 'ignite',
        reason: 'Vehicle has no main engine to ignite.',
        simTime: ctx.simTime,
      });
    } else {
      cmd.ignite = true;
      hasAnyCommand = true;
    }
  }

  // Attitude axes (-1..+1)
  for (const axis of ['pitch', 'yaw', 'roll'] as const) {
    const val = raw[axis];
    if (val === undefined || val === null) continue;
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      rejections.push({
        field: axis,
        reason: `${axis} command must be a finite number in [-1, 1].`,
        simTime: ctx.simTime,
      });
    } else {
      if (val < -1 || val > 1) {
        rejections.push({
          field: axis,
          reason: `${axis} command ${val.toFixed(2)} clamped to [-1, 1].`,
          simTime: ctx.simTime,
        });
      }
      cmd[axis] = Math.max(-1, Math.min(1, val));
      hasAnyCommand = true;
    }
  }

  // SAS Mode
  if (raw.sasMode !== undefined && raw.sasMode !== null) {
    const upper = typeof raw.sasMode === 'string' ? (raw.sasMode.toUpperCase() as SasMode) : null;
    if (!upper || !VALID_SAS_MODES.has(upper)) {
      rejections.push({
        field: 'sasMode',
        reason: `Invalid sasMode "${String(raw.sasMode)}". Allowed: OFF, HOLD, RETROGRADE, VERTICAL.`,
        simTime: ctx.simTime,
      });
    } else {
      cmd.sasMode = upper;
      hasAnyCommand = true;
    }
  }

  // Landing Gear
  if (raw.deployGear !== undefined && raw.deployGear !== null) {
    if (typeof raw.deployGear !== 'boolean') {
      rejections.push({
        field: 'deployGear',
        reason: 'deployGear must be a boolean (true or false).',
        simTime: ctx.simTime,
      });
    } else if (!ctx.hasLandingGear) {
      rejections.push({
        field: 'deployGear',
        reason: 'This spacecraft does not have deployable landing gear.',
        simTime: ctx.simTime,
      });
    } else {
      cmd.deployGear = raw.deployGear;
      hasAnyCommand = true;
    }
  }

  // Staging request
  if (raw.stage === true) {
    if (!ctx.canStage) {
      rejections.push({
        field: 'stage',
        reason: ctx.stageBlockedReason ?? 'No staging action currently available.',
        simTime: ctx.simTime,
      });
    } else {
      cmd.stage = true;
      hasAnyCommand = true;
    }
  }

  return { command: cmd, rejections, hasAnyCommand };
}

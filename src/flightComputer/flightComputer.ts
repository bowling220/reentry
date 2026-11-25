import {
  ConsoleEntry,
  ControlAuthority,
  FaultRecord,
  ProgramLanguage,
  ProgramRunState,
  RejectedCommandInfo,
  RuntimeStats,
  ValidatedFlightCommand,
} from './apiTypes';
import { createNeutralCommand } from './commandValidator';

/**
 * Independent virtual flight computer instance attached to a single spacecraft.
 *
 * Tracks program identity, execution state, simulation-time scheduling, control authority,
 * bounded console & fault logs, custom telemetry variables, and last validated commands.
 */
export class VirtualFlightComputer {
  public readonly computerId: string;
  public readonly spacecraftId: string;

  public language: ProgramLanguage = 'javascript';
  public programId: string | null = null;
  public programName = 'None Installed';
  public sourceCode = '';

  public runState: ProgramRunState = 'IDLE';
  public authority: ControlAuthority = 'ASSISTED';
  /** Scheduled simulation-time update rate (Hz) */
  public updateHz = 10;
  public simTimeAccumulatorS = 0;

  /** Active validated control command held between computer update ticks */
  public activeCommand: ValidatedFlightCommand = createNeutralCommand();
  public lastAcceptedCommand: ValidatedFlightCommand | null = null;
  public lastRejections: RejectedCommandInfo[] = [];

  public customVariables: Record<string, number | string | boolean> = {};
  public consoleHistory: ConsoleEntry[] = [];
  public faultHistory: FaultRecord[] = [];
  public runtimeStatusText = 'Idle';

  public stats: RuntimeStats = {
    lastExecMs: 0,
    avgExecMs: 0,
    maxExecMs: 0,
    memoryBytes: null,
    ticksExecuted: 0,
    droppedTicks: 0,
  };

  /** True while an async worker step request is currently in flight */
  public busy = false;
  public pendingRequestId: number | null = null;
  public pendingStartedAtMs = 0;

  private static readonly MAX_CONSOLE = 240;
  private static readonly MAX_FAULTS = 40;

  constructor(computerId: string, spacecraftId: string) {
    this.computerId = computerId;
    this.spacecraftId = spacecraftId;
  }

  public get updatePeriodS(): number {
    return 1 / Math.max(1, Math.min(20, this.updateHz));
  }

  public installProgram(
    programId: string,
    programName: string,
    language: ProgramLanguage,
    sourceCode: string
  ): void {
    this.programId = programId;
    this.programName = programName;
    this.language = language;
    this.sourceCode = sourceCode;
    this.runState = 'STOPPED';
    this.simTimeAccumulatorS = 0;
    this.activeCommand = createNeutralCommand();
    this.lastAcceptedCommand = null;
    this.lastRejections = [];
    this.customVariables = {};
    this.stats = {
      lastExecMs: 0,
      avgExecMs: 0,
      maxExecMs: 0,
      memoryBytes: null,
      ticksExecuted: 0,
      droppedTicks: 0,
    };
    this.pushLog(0, 'sys', `Installed ${language.toUpperCase()} program "${programName}".`);
  }

  public pushLog(simTime: number, level: ConsoleEntry['level'], message: string): void {
    this.consoleHistory.push({ simTime, level, message });
    if (this.consoleHistory.length > VirtualFlightComputer.MAX_CONSOLE) {
      this.consoleHistory.shift();
    }
  }

  public clearConsole(): void {
    this.consoleHistory = [];
  }

  public recordTiming(execMs: number, memoryBytes: number | null): void {
    this.stats.ticksExecuted += 1;
    this.stats.lastExecMs = execMs;
    this.stats.maxExecMs = Math.max(this.stats.maxExecMs, execMs);
    this.stats.avgExecMs =
      this.stats.ticksExecuted === 1
        ? execMs
        : this.stats.avgExecMs * 0.85 + execMs * 0.15;
    if (memoryBytes !== null) {
      this.stats.memoryBytes = memoryBytes;
    }
  }

  /**
   * Immediately revoke program authority and hand spacecraft back to manual/assisted flight.
   */
  public applyManualOverride(simTime: number, sasEnabled: boolean): void {
    this.authority = sasEnabled ? 'ASSISTED' : 'MANUAL';
    if (this.runState === 'RUNNING' || this.runState === 'PAUSED' || this.runState === 'FAULT') {
      this.runState = 'STOPPED';
    }
    this.activeCommand = createNeutralCommand();
    this.busy = false;
    this.pendingRequestId = null;
    this.runtimeStatusText = 'Manual Override';
    this.pushLog(simTime, 'warn', 'MANUAL OVERRIDE ENGAGED — Program control revoked.');
  }

  /**
   * Enter predictable safe fault fallback state (neutral stick, engine cut, SAS HOLD).
   */
  public enterFault(simTime: number, message: string, line: number | null = null): void {
    this.runState = 'FAULT';
    this.authority = 'FAULT';
    this.busy = false;
    this.pendingRequestId = null;
    this.runtimeStatusText = 'FAULT';
    // Safe fallback command: cut throttle, zero stick, hold attitude with SAS
    this.activeCommand = {
      throttle: 0,
      ignite: false,
      shutdown: true,
      pitch: 0,
      yaw: 0,
      roll: 0,
      sasMode: 'HOLD',
      deployGear: null,
      stage: false,
    };
    this.faultHistory.unshift({ simTime, message, line });
    if (this.faultHistory.length > VirtualFlightComputer.MAX_FAULTS) {
      this.faultHistory.pop();
    }
    const lineTag = line ? ` (line ${line})` : '';
    this.pushLog(simTime, 'error', `FAULT${lineTag}: ${message}`);
    this.pushLog(simTime, 'sys', 'Safe fallback active: throttle cut, neutral attitude, SAS HOLD.');
  }
}

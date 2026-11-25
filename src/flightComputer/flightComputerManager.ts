import {
  FlightEventType,
  ProgramLanguage,
  ProgramStepResult,
  RuntimeWorkerRequest,
  RuntimeWorkerResponse,
  ValidatedFlightCommand,
} from './apiTypes';
import { createNeutralCommand, validateProgramCommand } from './commandValidator';
import { VirtualFlightComputer } from './flightComputer';
import { buildProgramTelemetry } from './telemetryBridge';
import { FlightControlInput } from '../simulation/flightDynamics';
import { PlanetSimulation } from '../simulation/planetSimulation';
import { SpacecraftEntity, SpacecraftManager } from '../simulation/spacecraftManager';
import { computeTelemetry } from '../simulation/telemetry';

interface WorkerSlot {
  worker: Worker;
  language: ProgramLanguage;
  loadingRuntime: boolean;
}

/**
 * Orchestrates independent virtual flight computers and isolated sandbox Web Workers
 * across ALL simultaneously simulated spacecraft.
 *
 * Guarantees:
 * - One isolated QuickJS-WASM or lazy-loaded Pyodide Web Worker per running spacecraft computer.
 * - Simulation-time fixed-frequency scheduling (never coupled to rendering FPS).
 * - Hard outer watchdog termination so even unresponsive workers cannot hang the game.
 * - Instant manual override at any time regardless of program state.
 */
export class FlightComputerManager {
  private readonly computers = new Map<string, VirtualFlightComputer>();
  private readonly workers = new Map<string, WorkerSlot>();
  private readonly prevStatusMap = new Map<string, string>();
  private readonly prevIgnitedMap = new Map<string, boolean>();
  private readonly orbitEventSent = new Set<string>();

  private requestSeq = 1;
  private computerSeq = 1;

  private static readonly STEP_TIME_LIMIT_MS = 35;
  private static readonly HOST_WATCHDOG_MS = 450;
  private static readonly PYTHON_BOOT_WATCHDOG_MS = 28_000;
  private static readonly MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;

  public onStageRequested?: (craftId: string) => void;

  public reset(): void {
    for (const id of [...this.workers.keys()]) {
      this.terminateWorker(id);
    }
    this.computers.clear();
    this.prevStatusMap.clear();
    this.prevIgnitedMap.clear();
    this.orbitEventSent.clear();
  }

  /**
   * Ensure every spacecraft in `manager` has an independent virtual flight computer.
   */
  public syncSpacecraft(manager: SpacecraftManager): void {
    const presentIds = new Set<string>();
    for (const craft of manager.spacecraft) {
      presentIds.add(craft.id);
      if (!this.computers.has(craft.id)) {
        const fc = new VirtualFlightComputer(`fc-${this.computerSeq++}`, craft.id);
        fc.authority = craft.dynamics.sasEnabled ? 'ASSISTED' : 'MANUAL';
        this.computers.set(craft.id, fc);
        this.prevStatusMap.set(craft.id, craft.dynamics.status);
        this.prevIgnitedMap.set(craft.id, craft.dynamics.engineIgnited);
      }
    }

    for (const id of [...this.computers.keys()]) {
      if (!presentIds.has(id)) {
        this.terminateWorker(id);
        this.computers.delete(id);
        this.prevStatusMap.delete(id);
        this.prevIgnitedMap.delete(id);
        this.orbitEventSent.delete(id);
      }
    }
  }

  public getComputer(spacecraftId: string): VirtualFlightComputer {
    let fc = this.computers.get(spacecraftId);
    if (!fc) {
      fc = new VirtualFlightComputer(`fc-${this.computerSeq++}`, spacecraftId);
      this.computers.set(spacecraftId, fc);
    }
    return fc;
  }

  public getAllComputers(): VirtualFlightComputer[] {
    return [...this.computers.values()];
  }

  public installProgram(
    spacecraftId: string,
    programId: string,
    programName: string,
    language: ProgramLanguage,
    sourceCode: string
  ): VirtualFlightComputer {
    this.terminateWorker(spacecraftId);
    const fc = this.getComputer(spacecraftId);
    fc.installProgram(programId, programName, language, sourceCode);
    return fc;
  }

  /**
   * Explicitly start executing the installed program on `craft` and grant PROGRAM authority.
   */
  public startProgram(
    craft: SpacecraftEntity,
    manager: SpacecraftManager,
    planet: PlanetSimulation
  ): void {
    const fc = this.getComputer(craft.id);
    if (!fc.sourceCode.trim()) {
      fc.pushLog(planet.planetTimeS, 'warn', 'No program source installed to run.');
      return;
    }
    if (craft.dynamics.status === 'CRASHED') {
      fc.pushLog(planet.planetTimeS, 'error', 'Cannot run program on a destroyed spacecraft.');
      return;
    }

    // Always spin up a clean isolated worker for fresh execution state
    this.terminateWorker(craft.id);
    const slot = this.spawnWorker(craft.id, fc.language, manager, planet);
    this.workers.set(craft.id, slot);

    fc.runState = 'RUNNING';
    fc.authority = 'PROGRAM';
    fc.simTimeAccumulatorS = 0;
    fc.activeCommand = createNeutralCommand();
    fc.lastRejections = [];
    fc.customVariables = {};
    fc.runtimeStatusText = fc.language === 'python' ? 'Loading Python…' : 'Running';
    fc.pushLog(planet.planetTimeS, 'sys', `Starting ${fc.language.toUpperCase()} program "${fc.programName}"…`);

    const reqId = this.requestSeq++;
    fc.busy = true;
    fc.pendingRequestId = reqId;
    fc.pendingStartedAtMs = performance.now();

    const snap = computeTelemetry(craft.dynamics, planet);
    const apiTelem = buildProgramTelemetry(craft, snap, manager, planet, fc.updatePeriodS);

    const msg: RuntimeWorkerRequest = {
      type: 'load',
      requestId: reqId,
      code: fc.sourceCode,
      telemetry: apiTelem,
      timeLimitMs: FlightComputerManager.STEP_TIME_LIMIT_MS * 4,
      memoryLimitBytes: FlightComputerManager.MEMORY_LIMIT_BYTES,
    };
    slot.worker.postMessage(msg);
  }

  public pauseProgram(spacecraftId: string, simTime: number): void {
    const fc = this.getComputer(spacecraftId);
    if (fc.runState === 'RUNNING') {
      fc.runState = 'PAUSED';
      fc.runtimeStatusText = 'Paused';
      fc.pushLog(simTime, 'sys', 'Program execution paused.');
    }
  }

  public resumeProgram(spacecraftId: string, simTime: number): void {
    const fc = this.getComputer(spacecraftId);
    if (fc.runState === 'PAUSED') {
      fc.runState = 'RUNNING';
      fc.authority = 'PROGRAM';
      fc.runtimeStatusText = 'Running';
      fc.pushLog(simTime, 'sys', 'Program execution resumed.');
    }
  }

  public stopProgram(craft: SpacecraftEntity, simTime: number): void {
    const fc = this.getComputer(craft.id);
    this.terminateWorker(craft.id);
    fc.runState = 'STOPPED';
    fc.authority = craft.dynamics.sasEnabled ? 'ASSISTED' : 'MANUAL';
    fc.activeCommand = createNeutralCommand();
    fc.busy = false;
    fc.pendingRequestId = null;
    fc.runtimeStatusText = 'Stopped';
    fc.pushLog(simTime, 'sys', 'Program stopped. Control returned to pilot.');
  }

  /**
   * Immediately overrides program control (works even during an infinite loop or fault).
   */
  public manualOverride(craft: SpacecraftEntity, simTime: number): void {
    this.terminateWorker(craft.id);
    const fc = this.getComputer(craft.id);
    fc.applyManualOverride(simTime, craft.dynamics.sasEnabled);
  }

  /**
   * Executes exactly ONE program update cycle while simulation is paused (for step debugging).
   */
  public singleStepWhilePaused(
    craft: SpacecraftEntity,
    manager: SpacecraftManager,
    planet: PlanetSimulation
  ): void {
    const fc = this.getComputer(craft.id);
    if (!this.workers.has(craft.id)) {
      this.startProgram(craft, manager, planet);
      fc.runState = 'PAUSED';
      return;
    }
    if (fc.busy || fc.runState === 'FAULT') return;
    this.dispatchUpdate(craft, fc, manager, planet);
    fc.pushLog(planet.planetTimeS, 'sys', 'Executed single debug update step.');
  }

  /**
   * Notify running program of a discrete staging event.
   */
  public notifyStagingEvent(
    craft: SpacecraftEntity,
    detail: string,
    manager: SpacecraftManager,
    planet: PlanetSimulation
  ): void {
    this.dispatchEventIfRunning(craft, 'staging', { detail }, manager, planet);
  }

  /**
   * Returns warp safety restrictions required by running flight computers.
   */
  public computeWarpRestriction(): { maxWarp: number; reason: string | null } {
    let anyRunning = false;
    let anyBusy = false;
    for (const fc of this.computers.values()) {
      if (fc.runState === 'RUNNING') {
        anyRunning = true;
        if (fc.busy) anyBusy = true;
      }
    }
    if (anyBusy) return { maxWarp: 2, reason: 'FC BUSY' };
    if (anyRunning) return { maxWarp: 5, reason: 'PROGRAM' };
    return { maxWarp: 1000, reason: null };
  }

  /**
   * Convert a spacecraft's active flight computer state into a `FlightControlInput`
   * when that spacecraft is under `PROGRAM` or `FAULT` authority.
   */
  public getProgramControlInput(
    craft: SpacecraftEntity,
    manualInput: FlightControlInput | null
  ): FlightControlInput | null {
    const fc = this.getComputer(craft.id);

    // Keep MANUAL / ASSISTED authority badge synced cleanly when no program is in control
    if (fc.authority === 'MANUAL' || fc.authority === 'ASSISTED') {
      fc.authority = craft.dynamics.sasEnabled ? 'ASSISTED' : 'MANUAL';
      return manualInput;
    }

    // PROGRAM or FAULT authority drives validated commands into flight dynamics
    const cmd = fc.activeCommand;

    // One-shot flags consumed after feeding into physics
    const igniteNow = cmd.ignite;
    const shutdownNow = cmd.shutdown;
    const gearToggle =
      cmd.deployGear !== null && cmd.deployGear !== craft.dynamics.gearDeployed;

    if (cmd.sasMode !== null && cmd.sasMode !== craft.dynamics.sasMode) {
      craft.dynamics.setSasMode(cmd.sasMode);
    }

    const input: FlightControlInput = {
      pitch: cmd.pitch,
      yaw: cmd.yaw,
      roll: cmd.roll,
      throttleDelta: 0,
      setThrottle: shutdownNow ? 0 : cmd.throttle,
      ignitePressed: igniteNow,
      toggleGearPressed: gearToggle,
      toggleSasPressed: false,
      cycleSasModePressed: false,
    };

    // Clear one-shot pulse flags so they don't re-trigger every 60Hz substep
    cmd.ignite = false;
    cmd.shutdown = false;
    cmd.deployGear = null;

    return input;
  }

  /**
   * Advances simulation-time scheduling and watchdog checks for ALL flight computers.
   */
  public stepSimulationTime(
    dt: number,
    manager: SpacecraftManager,
    planet: PlanetSimulation
  ): void {
    this.syncSpacecraft(manager);
    const nowMs = performance.now();

    for (const craft of manager.spacecraft) {
      const fc = this.getComputer(craft.id);
      const dyn = craft.dynamics;

      // Detect discrete lifecycle events to notify running programs
      const prevStatus = this.prevStatusMap.get(craft.id) ?? dyn.status;
      const prevIgn = this.prevIgnitedMap.get(craft.id) ?? dyn.engineIgnited;

      if (prevStatus === 'PRELAUNCH' && dyn.hasLiftedOff) {
        this.dispatchEventIfRunning(craft, 'liftoff', {}, manager, planet);
      }
      if (!prevIgn && dyn.engineIgnited) {
        this.dispatchEventIfRunning(craft, 'ignition', {}, manager, planet);
      }
      if (prevIgn && !dyn.engineIgnited) {
        this.dispatchEventIfRunning(craft, 'shutdown', {}, manager, planet);
      }
      if (prevStatus !== 'LANDED' && dyn.status === 'LANDED') {
        this.dispatchEventIfRunning(craft, 'touchdown', {}, manager, planet);
      }
      if (prevStatus !== 'CRASHED' && dyn.status === 'CRASHED') {
        this.dispatchEventIfRunning(craft, 'destroyed', {}, manager, planet);
        if (fc.runState === 'RUNNING') {
          this.stopProgram(craft, planet.planetTimeS);
          fc.pushLog(planet.planetTimeS, 'error', 'Program halted: spacecraft destroyed.');
        }
      }

      this.prevStatusMap.set(craft.id, dyn.status);
      this.prevIgnitedMap.set(craft.id, dyn.engineIgnited);

      // Watchdog check on any in-flight worker call
      if (fc.busy && fc.pendingStartedAtMs > 0) {
        const slot = this.workers.get(craft.id);
        const limit =
          slot?.loadingRuntime
            ? FlightComputerManager.PYTHON_BOOT_WATCHDOG_MS
            : FlightComputerManager.HOST_WATCHDOG_MS;
        if (nowMs - fc.pendingStartedAtMs > limit) {
          this.terminateWorker(craft.id);
          fc.enterFault(
            planet.planetTimeS,
            slot?.loadingRuntime
              ? 'Python runtime timed out while loading.'
              : `Hard watchdog timeout (> ${limit} ms) — worker terminated.`,
            null
          );
          continue;
        }
      }

      if (fc.runState !== 'RUNNING' || dyn.status === 'CRASHED') continue;

      // Fixed simulation-time update scheduler
      fc.simTimeAccumulatorS += dt;
      if (fc.simTimeAccumulatorS >= fc.updatePeriodS) {
        fc.simTimeAccumulatorS %= fc.updatePeriodS;
        if (fc.busy) {
          fc.stats.droppedTicks += 1;
        } else {
          this.dispatchUpdate(craft, fc, manager, planet);
        }
      }
    }
  }

  private dispatchUpdate(
    craft: SpacecraftEntity,
    fc: VirtualFlightComputer,
    manager: SpacecraftManager,
    planet: PlanetSimulation
  ): void {
    const slot = this.workers.get(craft.id);
    if (!slot) return;

    const snap = computeTelemetry(craft.dynamics, planet);
    if (snap.orbital.classification === 'ORBITAL' && !this.orbitEventSent.has(craft.id)) {
      this.orbitEventSent.add(craft.id);
      this.dispatchEventIfRunning(craft, 'orbit_achieved', {
        apoapsisM: snap.orbital.apoapsisAltM,
        periapsisM: snap.orbital.periapsisAltM,
      }, manager, planet);
    }

    const apiTelem = buildProgramTelemetry(craft, snap, manager, planet, fc.updatePeriodS);
    const reqId = this.requestSeq++;
    fc.busy = true;
    fc.pendingRequestId = reqId;
    fc.pendingStartedAtMs = performance.now();

    const msg: RuntimeWorkerRequest = {
      type: 'update',
      requestId: reqId,
      telemetry: apiTelem,
      timeLimitMs: FlightComputerManager.STEP_TIME_LIMIT_MS,
    };
    slot.worker.postMessage(msg);
  }

  private dispatchEventIfRunning(
    craft: SpacecraftEntity,
    eventName: FlightEventType,
    payload: Record<string, unknown>,
    manager: SpacecraftManager,
    planet: PlanetSimulation
  ): void {
    const fc = this.computers.get(craft.id);
    const slot = this.workers.get(craft.id);
    if (!fc || !slot || fc.runState !== 'RUNNING' || fc.busy) return;

    const snap = computeTelemetry(craft.dynamics, planet);
    const apiTelem = buildProgramTelemetry(craft, snap, manager, planet, fc.updatePeriodS);
    const reqId = this.requestSeq++;
    fc.busy = true;
    fc.pendingRequestId = reqId;
    fc.pendingStartedAtMs = performance.now();

    const msg: RuntimeWorkerRequest = {
      type: 'event',
      requestId: reqId,
      eventName,
      payload,
      telemetry: apiTelem,
      timeLimitMs: FlightComputerManager.STEP_TIME_LIMIT_MS,
    };
    slot.worker.postMessage(msg);
  }

  private spawnWorker(
    spacecraftId: string,
    language: ProgramLanguage,
    manager: SpacecraftManager,
    planet: PlanetSimulation
  ): WorkerSlot {
    const worker =
      language === 'javascript'
        ? new Worker(new URL('./workers/jsRuntime.worker.ts', import.meta.url), { type: 'module' })
        : new Worker(new URL('./workers/pythonRuntime.worker.ts', import.meta.url), { type: 'module' });

    const slot: WorkerSlot = {
      worker,
      language,
      loadingRuntime: language === 'python',
    };

    worker.onmessage = (ev: MessageEvent<RuntimeWorkerResponse>) => {
      const data = ev.data;
      const fc = this.computers.get(spacecraftId);
      if (!fc) return;

      if (data.type === 'status') {
        fc.runtimeStatusText = data.message;
        fc.pushLog(planet.planetTimeS, 'sys', data.message);
        return;
      }

      if (data.type === 'result') {
        slot.loadingRuntime = false;
        if (fc.pendingRequestId !== data.requestId) return;
        fc.busy = false;
        fc.pendingRequestId = null;
        this.applyStepResult(spacecraftId, fc, data.result, manager, planet);
      }
    };

    worker.onerror = (err) => {
      const fc = this.computers.get(spacecraftId);
      if (fc) {
        fc.enterFault(planet.planetTimeS, `Worker error: ${err.message || 'Unknown worker failure'}`, null);
      }
      this.terminateWorker(spacecraftId);
    };

    return slot;
  }

  private applyStepResult(
    spacecraftId: string,
    fc: VirtualFlightComputer,
    result: ProgramStepResult,
    manager: SpacecraftManager,
    planet: PlanetSimulation
  ): void {
    for (const l of result.logs) {
      fc.pushLog(planet.planetTimeS, l.level, l.message);
    }

    fc.customVariables = { ...result.customVars };
    fc.recordTiming(result.execTimeMs, result.memoryBytes);

    if (!result.ok) {
      this.terminateWorker(spacecraftId);
      fc.enterFault(planet.planetTimeS, result.error ?? 'Runtime fault', result.line ?? null);
      return;
    }

    if (fc.runState === 'RUNNING') {
      fc.runtimeStatusText = 'Running';
    }

    const craft = manager.spacecraft.find((s) => s.id === spacecraftId);
    if (!craft) return;

    const stageAction = manager.getNextStageAction(craft);
    const validated = validateProgramCommand(result.command, {
      simTime: planet.planetTimeS,
      hasEngine: craft.dynamics.config.maxThrustVacN > 0,
      hasLandingGear: craft.dynamics.hasLandingGear,
      canStage: stageAction.available,
      stageBlockedReason: stageAction.blockedReason,
      isDestroyed: craft.dynamics.status === 'CRASHED',
    });

    if (validated.rejections.length > 0) {
      fc.lastRejections = validated.rejections;
      for (const r of validated.rejections) {
        fc.pushLog(planet.planetTimeS, 'warn', `Rejected [${r.field}]: ${r.reason}`);
      }
    }

    if (validated.hasAnyCommand) {
      this.mergeCommand(fc.activeCommand, validated.command);
      fc.lastAcceptedCommand = { ...fc.activeCommand };
    }

    // Execute validated staging request if commanded by program
    if (validated.command.stage && craft.id === manager.activeId) {
      this.onStageRequested?.(craft.id);
    } else if (validated.command.stage) {
      // Allow non-active craft to stage cleanly if supported
      const prevActive = manager.activeId;
      manager.activeId = craft.id;
      const didStage = manager.triggerStage();
      manager.activeId = prevActive;
      if (didStage) {
        fc.pushLog(planet.planetTimeS, 'sys', 'Autonomous staging executed.');
      }
    }
  }

  private mergeCommand(target: ValidatedFlightCommand, next: ValidatedFlightCommand): void {
    if (next.throttle !== null) target.throttle = next.throttle;
    if (next.ignite) target.ignite = true;
    if (next.shutdown) {
      target.shutdown = true;
      target.throttle = 0;
    }
    target.pitch = next.pitch;
    target.yaw = next.yaw;
    target.roll = next.roll;
    if (next.sasMode !== null) target.sasMode = next.sasMode;
    if (next.deployGear !== null) target.deployGear = next.deployGear;
    target.stage = false;
  }

  private terminateWorker(spacecraftId: string): void {
    const slot = this.workers.get(spacecraftId);
    if (slot) {
      try {
        slot.worker.terminate();
      } catch {
        // ignore
      }
      this.workers.delete(spacecraftId);
    }
  }
}

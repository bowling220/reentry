import test from 'node:test';
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { validateProgramCommand } from '../src/flightComputer/commandValidator';
import { VirtualFlightComputer } from '../src/flightComputer/flightComputer';
import { LocalPhysicsWorld } from '../src/simulation/localPhysics';
import { PlanetSimulation } from '../src/simulation/planetSimulation';
import { FLIGHT_SCENARIOS, loadFlightScenario } from '../src/simulation/scenarios';
import { SpacecraftManager } from '../src/simulation/spacecraftManager';
import { computeTelemetry } from '../src/simulation/telemetry';

test('QuickJS-WASM runtime blocks host globals (DOM, fetch, storage, Node globals)', async () => {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const vm = runtime.newContext();

  try {
    const res = vm.evalCode(`
      JSON.stringify({
        fetch: typeof fetch,
        window: typeof window,
        document: typeof document,
        localStorage: typeof localStorage,
        XMLHttpRequest: typeof XMLHttpRequest,
        WebSocket: typeof WebSocket,
        process: typeof process,
        require: typeof require
      });
    `);
    assert.ok(!res.error, 'sandbox probe script should evaluate cleanly');
    const parsed = JSON.parse(vm.dump(res.value) as string) as Record<string, string>;
    res.value.dispose();

    for (const [name, kind] of Object.entries(parsed)) {
      assert.equal(kind, 'undefined', `host global "${name}" must not exist in QuickJS sandbox`);
    }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
});

test('QuickJS-WASM interrupt handler terminates infinite loops within budget', async () => {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);

  const startedAt = performance.now();
  const deadline = startedAt + 60;
  let checks = 0;
  runtime.setInterruptHandler(() => {
    checks += 1;
    return checks > 400_000 || performance.now() > deadline;
  });

  const vm = runtime.newContext();
  try {
    const res = vm.evalCode('while (true) {}');
    const elapsedMs = performance.now() - startedAt;

    assert.ok(res.error, 'infinite loop must fail with an interrupt error');
    const errDump = vm.dump(res.error);
    res.error.dispose();
    assert.ok(
      String(errDump?.message ?? errDump).toLowerCase().includes('interrupt'),
      `expected interrupted error, got: ${JSON.stringify(errDump)}`
    );
    assert.ok(elapsedMs < 500, `infinite loop took too long to terminate: ${elapsedMs.toFixed(1)} ms`);
  } finally {
    vm.dispose();
    runtime.dispose();
  }
});

test('Command validator clamps valid controls and rejects invalid/unknown/disallowed commands', () => {
  const res = validateProgramCommand(
    {
      throttle: 1.8, // should clamp to 1.0
      pitch: -2.5, // should clamp to -1.0
      yaw: Number.NaN, // rejected
      roll: 0.25,
      deployGear: true, // rejected when hasLandingGear=false
      stage: true, // rejected when canStage=false
      sasMode: 'BOGUS_MODE' as unknown as 'HOLD', // rejected
      hackPhysics: 999, // unknown field rejected
    } as Record<string, unknown>,
    {
      simTime: 10,
      hasEngine: true,
      hasLandingGear: false,
      canStage: false,
      stageBlockedReason: 'Staging safeguard active',
      isDestroyed: false,
    }
  );

  assert.equal(res.command.throttle, 1);
  assert.equal(res.command.pitch, -1);
  assert.equal(res.command.yaw, 0);
  assert.equal(res.command.roll, 0.25);
  assert.equal(res.command.deployGear, null);
  assert.equal(res.command.stage, false);
  assert.equal(res.command.sasMode, null);

  const rejectedFields = new Set(res.rejections.map((r) => r.field));
  assert.ok(rejectedFields.has('yaw'));
  assert.ok(rejectedFields.has('deployGear'));
  assert.ok(rejectedFields.has('stage'));
  assert.ok(rejectedFields.has('sasMode'));
  assert.ok(rejectedFields.has('hackPhysics'));

  // Destroyed craft must reject all commands
  const destroyed = validateProgramCommand(
    { throttle: 1, ignite: true },
    {
      simTime: 12,
      hasEngine: true,
      hasLandingGear: true,
      canStage: true,
      stageBlockedReason: null,
      isDestroyed: true,
    }
  );
  assert.equal(destroyed.hasAnyCommand, false);
  assert.equal(destroyed.command.ignite, false);
  assert.equal(destroyed.rejections.length, 1);
});

test('VirtualFlightComputer enters safe fallback on fault and immediately yields on manual override', () => {
  const fc = new VirtualFlightComputer('fc-test', 'reentry-9-main');
  fc.installProgram('p1', 'test.js', 'javascript', 'function update() {}');
  fc.runState = 'RUNNING';
  fc.authority = 'PROGRAM';
  fc.activeCommand.throttle = 1;
  fc.activeCommand.pitch = 0.8;

  // Fault must trigger safe predictable fallback: cutoff throttle, zero attitude, SAS HOLD
  fc.enterFault(42.5, 'Execution time budget exceeded', 14);
  assert.equal(fc.runState, 'FAULT');
  assert.equal(fc.authority, 'FAULT');
  assert.equal(fc.activeCommand.throttle, 0);
  assert.equal(fc.activeCommand.shutdown, true);
  assert.equal(fc.activeCommand.pitch, 0);
  assert.equal(fc.activeCommand.sasMode, 'HOLD');
  assert.equal(fc.faultHistory.length, 1);
  assert.equal(fc.faultHistory[0].line, 14);

  // Manual override immediately reclaims authority even from FAULT state
  fc.applyManualOverride(43.0, true);
  assert.equal(fc.runState, 'STOPPED');
  assert.equal(fc.authority, 'ASSISTED');
  assert.equal(fc.activeCommand.throttle, null);

  fc.applyManualOverride(44.0, false);
  assert.equal(fc.authority, 'MANUAL');
});

test('All 7 flight testing scenarios initialize finite spacecraft states and step cleanly', async () => {
  await LocalPhysicsWorld.initRapier();
  assert.equal(FLIGHT_SCENARIOS.length, 7);

  for (const sc of FLIGHT_SCENARIOS) {
    const planet = new PlanetSimulation();
    const manager = new SpacecraftManager();
    const meta = loadFlightScenario(sc.id, manager, planet);
    assert.equal(meta.id, sc.id);
    assert.ok(manager.spacecraft.length >= 1, `scenario ${sc.id} must spawn at least 1 spacecraft`);

    // Step 5 simulation ticks with neutral input and confirm finite telemetry
    for (let i = 0; i < 5; i++) {
      planet.step(1 / 60);
      manager.stepAll(
        1 / 60,
        {
          pitch: 0,
          yaw: 0,
          roll: 0,
          throttleDelta: 0,
          setThrottle: null,
          ignitePressed: false,
          toggleGearPressed: false,
          toggleSasPressed: false,
          cycleSasModePressed: false,
        },
        planet
      );
    }

    const active = manager.activeSpacecraft;
    const telem = computeTelemetry(active.dynamics, planet);
    assert.ok(Number.isFinite(telem.altitudeASLM), `${sc.id} altitude must be finite`);
    assert.ok(Number.isFinite(telem.totalVelocityMs), `${sc.id} speed must be finite`);
    assert.ok(Number.isFinite(telem.totalMassKg) && telem.totalMassKg > 0, `${sc.id} mass must be positive`);

    if (sc.id === 'upper_stage_orbit' || sc.id === 'satellite_deploy') {
      assert.equal(
        telem.orbital.classification,
        'ORBITAL',
        `${sc.id} should initialize in a stable LEO orbit`
      );
      assert.ok((telem.orbital.periapsisAltM ?? 0) > 150_000, `${sc.id} periapsis should exceed 150 km`);
    }
    if (sc.id === 'near_ground_landing') {
      assert.ok(
        telem.altitudeAGLM > 700 && telem.altitudeAGLM < 1100,
        `near_ground_landing AGL should be near 950m, got ${telem.altitudeAGLM}`
      );
    }
  }
});

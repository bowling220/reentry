import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { AUTO_DEMOS } from '../src/flightComputer/demoPrograms';
import { validateProgramCommand } from '../src/flightComputer/commandValidator';
import { buildProgramTelemetry } from '../src/flightComputer/telemetryBridge';
import { LocalPhysicsWorld } from '../src/simulation/localPhysics';
import { SpacecraftManager } from '../src/simulation/spacecraftManager';
import { PlanetSimulation } from '../src/simulation/planetSimulation';
import { loadFlightScenario } from '../src/simulation/scenarios';
import { computeTelemetry } from '../src/simulation/telemetry';
import { NEUTRAL_FLIGHT_INPUT } from '../src/simulation/flightDynamics';
import { configureDemoVehicle } from '../src/simulation/demoFlights';
import { ProgramLibrary } from '../src/flightComputer/programLibrary';

await LocalPhysicsWorld.initRapier();

test('new demos appear in an existing local library without overwriting player edits', async () => {
  const globals = globalThis as any;
  const previous = globals.localStorage;
  let saved = JSON.stringify([
    { id: 'player-flight', name: 'my_flight.js', code: '// my program', language: 'javascript', updatedAt: 1 },
    { ...AUTO_DEMOS[0].program, code: '// customized hop' },
  ]);
  globals.localStorage = { getItem: () => saved, setItem: (_: string, value: string) => { saved = value; } };
  try {
    const library = new ProgramLibrary();
    await library.init();
    assert.equal(library.getById('player-flight')?.code, '// my program');
    assert.equal(library.getById(AUTO_DEMOS[0].program.id)?.code, '// customized hop');
    assert.ok(library.getById(AUTO_DEMOS[1].program.id));
    assert.ok(library.getById(AUTO_DEMOS[2].program.id));
    assert.equal(library.getAll().length, 4);
  } finally {
    if (previous === undefined) delete globals.localStorage;
    else globals.localStorage = previous;
  }
});
for (const hz of [5, 10]) for (const demo of AUTO_DEMOS) {
  test(`automatic demo completes a real landing at ${hz} Hz: ${demo.name}`, () => {
    const manager = new SpacecraftManager();
    const planet = new PlanetSimulation();
    loadFlightScenario(demo.scenario, manager, planet);
    configureDemoVehicle(demo, manager);
    const craft = manager.activeSpacecraft, dyn = craft.dynamics;
    let raw: Record<string, unknown> = {};
    let phase = '';
    const api = {
      log: () => {}, record: (key: string, value: unknown) => { if (key === 'phase') phase = String(value); },
      setThrottle: (value: number) => { raw.throttle = value; },
      ignite: () => { raw.ignite = true; }, shutdown: () => { raw.shutdown = true; },
      setSasMode: (value: string) => { raw.sasMode = value; },
      setLandingGear: (value: boolean) => { raw.deployGear = value; },
      setAttitude: (p: number, y: number, r: number) => { raw.pitch = p; raw.yaw = y; raw.roll = r; },
    };
    const context = createContext({ api, t: null });
    new Script(demo.program.code).runInContext(context);
    const init = new Script('init(api, t)'), update = new Script('update(t, api)');
    const snapshot = () => buildProgramTelemetry(craft, computeTelemetry(dyn, planet), manager, planet, 1 / hz);
    context.t = snapshot(); init.runInContext(context);
    let command = validateProgramCommand({}, { simTime: 0, hasEngine: true, hasLandingGear: true, canStage: true, stageBlockedReason: null, isDestroyed: false }).command;
    let maxAltitude = 0;
    let landedAt = -1;
    for (let i = 0; i < 60 * 1000; i++) {
      if (i % (60 / hz) === 0) {
        raw = {}; context.t = snapshot(); update.runInContext(context);
        const result = validateProgramCommand(raw, { simTime: planet.planetTimeS, hasEngine: true,
          hasLandingGear: true, canStage: manager.getNextStageAction().available, stageBlockedReason: null, isDestroyed: false });
        assert.equal(result.rejections.length, 0);
        command = result.command;
      }
      if (command.sasMode) dyn.setSasMode(command.sasMode);
      if (command.deployGear !== null) dyn.setLandingGear(command.deployGear);
      planet.step(1 / 60);
      manager.stepAll(1 / 60, { ...NEUTRAL_FLIGHT_INPUT, pitch: command.pitch, yaw: command.yaw,
        roll: command.roll, setThrottle: command.shutdown ? 0 : command.throttle,
        ignitePressed: command.ignite }, planet);
      command.ignite = false; command.shutdown = false;
      maxAltitude = Math.max(maxAltitude, dyn.getAltitudeAGL());
      if (landedAt >= 0) assert.equal(dyn.status, 'LANDED', 'confirmed touchdown remains stable while the gear settles');
      if (dyn.status === 'LANDED' && landedAt < 0) landedAt = i;
      if (dyn.status === 'CRASHED' || (landedAt >= 0 && i - landedAt >= 180)) break;
    }
    const final = snapshot();
    console.log(demo.id, { maxAltitude, seconds: planet.planetTimeS, distanceFromLzM: final.landingTarget.distanceM });
    assert.equal(dyn.status, 'LANDED', `${demo.id} ended in ${dyn.status}, phase ${phase}, altitude ${dyn.getAltitudeAGL()}`);
    assert.equal(dyn.gearDeployed, true);
    assert.equal(manager.consumeEvents().filter(event => event.title === 'TOUCHDOWN').length, 1);
    assert.ok(dyn.propellantKg > 0, 'retains landing fuel');
    assert.ok(final.velocity.horizontal < 8.5, 'lands without excessive lateral drift');
    if (demo.id === 'space-return') assert.ok(maxAltitude > 100000);
    if (demo.id === 'hop') assert.ok(maxAltitude > 800 && maxAltitude < 1500);
  });
}

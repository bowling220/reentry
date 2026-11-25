import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { RETURN_HOME_PROGRAM } from '../src/flightComputer/coastalProgram';
import { buildProgramTelemetry } from '../src/flightComputer/telemetryBridge';
import { validateProgramCommand } from '../src/flightComputer/commandValidator';
import { LocalPhysicsWorld } from '../src/simulation/localPhysics';
import { SpacecraftManager } from '../src/simulation/spacecraftManager';
import { PlanetSimulation } from '../src/simulation/planetSimulation';
import { computeTelemetry } from '../src/simulation/telemetry';
import { RocketFlightDynamics, NEUTRAL_FLIGHT_INPUT } from '../src/simulation/flightDynamics';
import { STAGE1_BOOSTER_SPEC } from '../src/config/vehicleConfig';
import { CAPE_FRAME } from '../src/simulation/terrainHeight';
import { localPointToECEF, localVectorToECEF, localQuatToECEF } from '../src/math/coordinates';
import { quatFromAxisAngle } from '../src/math/vec3d';

await LocalPhysicsWorld.initRapier();
test('empty tank is reported as unpowered without ignition or invented fuel', () => {
  const manager = new SpacecraftManager(), planet = new PlanetSimulation();
  const craft = manager.activeSpacecraft, dyn = craft.dynamics;
  dyn.initializeAirborneState(localPointToECEF({ x: 0, y: 1000, z: 0 }, CAPE_FRAME),
    localVectorToECEF({ x: 0, y: -20, z: 0 }, CAPE_FRAME), CAPE_FRAME.localToECEF, { x: 0, y: 0, z: 0 }, 0, 100, false);
  const t = buildProgramTelemetry(craft, computeTelemetry(dyn, planet), manager, planet, 0.1);
  const variables: Record<string, any> = {};
  const api = { record(k: string, value: any) { variables[k] = value; }, log() {}, shutdown() {}, setSasMode() {},
    setAttitude() {}, setLandingGear() {}, ignite() { assert.fail('cannot ignite with empty tanks'); },
    setThrottle(value: number) { assert.equal(value, 0); } };
  const context = createContext({ t, api });
  new Script(RETURN_HOME_PROGRAM.code + ';init(api,t);update(t,api)').runInContext(context);
  assert.equal(variables.return_mode, 'UNPOWERED');
  assert.equal(dyn.propellantKg, 0);
});
const cases = [
  { name: 'manual flight moving away', x: 300, z: 4000, h: 1500, vx: 0, vz: 70, vy: 0, fuel: 200000, mode: 'HOME' },
  { name: 'longer trip at high speed', x: 0, z: 15000, h: 3000, vx: 0, vz: 150, vy: 0, fuel: 250000, mode: 'HOME' },
  { name: 'return from suborbital coast', x: -320, z: 520, h: 35000, vx: 0, vz: 0, vy: -300, fuel: 100000, mode: 'HOME' },
  { name: 'insufficient fuel for distant home', x: -5000, z: 50000, h: 950, vx: 0, vz: 0, vy: -50, fuel: 30000, mode: 'LOCAL_LANDING' },
  { name: 'nearly empty engine below minimum hover thrust', x: -5000, z: 50000, h: 500, vx: 0, vz: 0, vy: -25, fuel: 8000, mode: 'LOCAL_LANDING' },
  { name: 'full launch stack in manual flight', x: -320, z: 2520, h: 1500, vx: 0, vz: 30, vy: 0, fuel: 300000, mode: 'HOME', stack: true },
  { name: 'tilted craft at button press', x: -320, z: 2520, h: 2500, vx: 20, vz: 30, vy: 0, fuel: 250000, mode: 'HOME', tilt: 0.8 },
];
for (const hz of [5, 10]) for (const c of cases) test(`adaptive recovery ${hz} Hz: ${c.name}`, () => {
  const manager = new SpacecraftManager();
  const planet = new PlanetSimulation();
  const craft = manager.activeSpacecraft;
  if (!c.stack) { craft.dynamics = new RocketFlightDynamics(STAGE1_BOOSTER_SPEC.config, true); craft.role = 'booster'; }
  const dyn = craft.dynamics;
  dyn.initializeAirborneState(localPointToECEF({ x: c.x, y: c.h + dyn.config.heightM / 2 + 4, z: c.z }, CAPE_FRAME),
    localVectorToECEF({ x: c.vx, y: c.vy, z: c.vz }, CAPE_FRAME), localQuatToECEF(quatFromAxisAngle({ x: 1, y: 0, z: 0 }, c.tilt ?? 0), CAPE_FRAME),
    { x: 0, y: 0, z: 0 }, c.fuel, 200, false);
  const telemetry = () => buildProgramTelemetry(craft, computeTelemetry(dyn, planet), manager, planet, 1 / hz);
  let raw: any = {}, variables: Record<string, any> = {};
  const api: any = { log() {}, record(k: string, v: any) { variables[k] = v; },
    shutdown() { raw.shutdown = true; raw.throttle = 0; }, ignite() { raw.ignite = true; },
    setThrottle(v: number) { raw.throttle = v; }, setAttitude(p: number, y: number, r: number) { raw.pitch = p; raw.yaw = y; raw.roll = r; },
    setSasMode(v: string) { raw.sasMode = v; }, setLandingGear(v: boolean) { raw.deployGear = v; } };
  const context = createContext({ api, t: telemetry() });
  new Script(RETURN_HOME_PROGRAM.code).runInContext(context);
  const before = { ...dyn.posECEF };
  new Script('init(api, t)').runInContext(context);
  assert.deepEqual(dyn.posECEF, before);
  assert.equal(dyn.propellantKg, c.fuel);
  assert.equal(variables.return_mode, c.mode);
  const tick = new Script('update(t, api)');
  let command: any, previousFuel = c.fuel, landedAt = -1;
  for (let i = 0; i < 60 * 1000; i++) {
    if (i % (60 / hz) === 0) {
      raw = {}; context.t = telemetry(); tick.runInContext(context);
      const result = validateProgramCommand(raw, { simTime: planet.planetTimeS, hasEngine: true, hasLandingGear: true,
        canStage: false, stageBlockedReason: null, isDestroyed: false });
      assert.equal(result.rejections.length, 0, JSON.stringify(result.rejections));
      command = result.command;
    }
    if (command.sasMode) dyn.setSasMode(command.sasMode);
    if (command.deployGear !== null) dyn.setLandingGear(command.deployGear);
    planet.step(1 / 60);
    manager.stepAll(1 / 60, { ...NEUTRAL_FLIGHT_INPUT, pitch: command.pitch, yaw: command.yaw, roll: command.roll,
      setThrottle: command.shutdown ? 0 : command.throttle, ignitePressed: command.ignite }, planet);
    command.ignite = false; command.shutdown = false;
    assert.ok(dyn.propellantKg <= previousFuel + 1e-8, 'guidance never refills propellant');
    previousFuel = dyn.propellantKg;
    if (dyn.status === 'LANDED' && landedAt < 0) landedAt = i;
    if (dyn.status === 'CRASHED' || landedAt >= 0 && i - landedAt > 180) break;
  }
  const t = telemetry();
  console.log(c.name, { status: dyn.status, phase: variables.phase, mode: variables.return_mode, seconds: planet.planetTimeS,
    h: t.position.altitudeAGL, fuel: dyn.propellantKg, distance: t.landingTarget.distanceM, speed: t.velocity.horizontal });
  assert.equal(dyn.status, 'LANDED');
  assert.equal(variables.return_mode, c.mode);
  assert.ok(dyn.propellantKg > 0);
  if (c.mode === 'HOME') assert.ok(t.landingTarget.distanceM < 43);
});


import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FALCON9_CLASS_CONFIG as config } from '../src/config/rocketConfig';
import { buildTangentFrame, localPointToECEF, localVectorToECEF } from '../src/math/coordinates';
import { mulQuat, quatFromAxisAngle } from '../src/math/vec3d';
import { RocketFlightDynamics, FlightControlInput } from '../src/simulation/flightDynamics';
import { LocalPhysicsWorld } from '../src/simulation/localPhysics';
import { PlanetSimulation } from '../src/simulation/planetSimulation';
import { SimulationClock } from '../src/simulation/simulationLoop';
import { InputManager } from '../src/input/inputManager';

await LocalPhysicsWorld.initRapier();
const neutral: FlightControlInput = { pitch: 0, yaw: 0, roll: 0, throttleDelta: 0,
  setThrottle: null, ignitePressed: false, toggleGearPressed: false, toggleSasPressed: false };

function airborne(altitude = 200_000) {
  const rocket = new RocketFlightDynamics(config);
  const frame = buildTangentFrame(28.562, -80.577, altitude);
  rocket.posECEF = frame.originECEF;
  rocket.quatECEF = frame.localToECEF;
  rocket.hasLiftedOff = true;
  rocket.inGroundContact = false;
  rocket.status = altitude >= 100_000 ? 'SPACEFLIGHT' : 'ASCENT';
  (rocket as any).usingLocalPhysics = false;
  (rocket as any).holdDownClampsActive = false;
  return { rocket, frame, planet: new PlanetSimulation() };
}

test('SAS reduces positive and negative angular rates on all axes in vacuum', () => {
  for (const axis of ['x', 'y', 'z'] as const) {
    for (const sign of [-1, 1]) {
      const { rocket, planet } = airborne();
      rocket.angVelBody[axis] = sign * 0.1;
      for (let i = 0; i < 600; i++) rocket.step(1 / 60, neutral, planet);
      assert.ok(Math.abs(rocket.angVelBody[axis]) < 0.09,
        `${axis} ${sign}: SAS amplified or failed to damp spin: ${rocket.angVelBody[axis]}`);
    }
  }
});

test('SAS also damps pitch and yaw while engines are firing', () => {
  for (const axis of ['x', 'z'] as const) {
    const { rocket, planet } = airborne();
    rocket.angVelBody[axis] = 0.03;
    rocket.engineIgnited = true;
    rocket.throttle = rocket.actualThrottle = 1;
    for (let i = 0; i < 120; i++) rocket.step(1 / 60, neutral, planet);
    assert.ok(Math.abs(rocket.angVelBody[axis]) < 0.03);
  }
});

test('aerodynamic moment restores a small angle of attack', () => {
  const { rocket, frame, planet } = airborne(10_000);
  rocket.sasEnabled = false;
  rocket.quatECEF = mulQuat(frame.localToECEF, quatFromAxisAngle({ x: 1, y: 0, z: 0 }, 0.05));
  rocket.velECEF = localVectorToECEF({ x: 0, y: 300, z: 0 }, frame);
  rocket.step(1 / 60, neutral, planet);
  assert.ok(rocket.angVelBody.x < 0, 'airflow should rotate the nose back toward the velocity vector');
});

test('attitude telemetry distinguishes inverted flight and has a stable vertical heading', () => {
  const { rocket, frame } = airborne();
  assert.ok(Math.abs(rocket.getLocalAttitudeDeg().headingDeg) < 0.01);
  const horizontal = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);
  const bank = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 2 * Math.PI / 3);
  rocket.quatECEF = mulQuat(frame.localToECEF, mulQuat(horizontal, bank));
  assert.ok(Math.abs(rocket.getLocalAttitudeDeg().rollDeg + 120) < 0.01);
});

test('Rapier mass, center of mass, and inertia match planetary physics with and without gear', () => {
  const physics = new LocalPhysicsWorld(config, config.comHeightFullM);
  const mass = 100_000;
  for (const gear of [false, true]) {
    physics.setLandingGearDeployed(gear);
    physics.setMassProperties(mass);
    physics.setKinematicState({ x: 0, y: 250, z: 0 }, { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 });
    physics.step(1 / 60, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const body = (physics as any).rocketBody;
    assert.ok(Math.abs(body.mass() - mass) < 1);
    assert.ok(Math.abs(body.localCom().y) < 0.001);
    const expected = mass * (3 * (config.diameterM / 2) ** 2 + config.heightM ** 2) / 12;
    assert.ok(Math.abs(body.principalInertia().x / expected - 1) < 0.001);
  }
});

test('hands-off launch crosses 100 km with finite state and stays upright', () => {
  const rocket = new RocketFlightDynamics(config);
  const planet = new PlanetSimulation();
  rocket.triggerLaunchOrIgnition();
  for (let i = 0; i < 60 * 210 && rocket.getAltitudeASL() < 100_100; i++) {
    planet.step(1 / 60);
    rocket.step(1 / 60, neutral, planet);
    assert.ok(Number.isFinite(rocket.posECEF.x));
    assert.notEqual(rocket.status, 'CRASHED');
  }
  assert.ok(rocket.getAltitudeASL() >= 100_000, `reached only ${rocket.getAltitudeASL()} m`);
  assert.equal(rocket.status, 'SPACEFLIGHT');
  assert.ok(rocket.getLocalAttitudeDeg().tiltFromVerticalDeg < 5);
});

test('high-refresh frames preserve launch and toggles until physics consumes them exactly once', () => {
  const events = new Map<string, Function>();
  (globalThis as any).window = { addEventListener: (name: string, listener: Function) => events.set(name, listener) };
  const input = new InputManager();
  const clock = new SimulationClock();
  const press = (code: string) => {
    events.get('keydown')!({ code, target: { tagName: 'BODY' }, preventDefault() {} });
    events.get('keyup')!({ code });
  };
  press('Space'); press('KeyG'); press('KeyZ');
  let launches = 0; let gears = 0; let throttles = 0;
  for (let i = 0; i < 20; i++) clock.advance(1 / 240, false, () => {
    const controls = input.consumeFlightInput();
    launches += Number(controls.ignitePressed);
    gears += Number(controls.toggleGearPressed);
    throttles += Number(controls.setThrottle === 1);
  });
  assert.equal(launches, 1); assert.equal(gears, 1); assert.equal(throttles, 1);
  press('KeyT'); press('KeyX');
  assert.equal(input.consumeMechanismToggles().sas, true);
  assert.equal(input.consumeFlightInput().setThrottle, 0);
  press('Space'); events.get('blur')!();
  assert.equal(input.consumeFlightInput().ignitePressed, false);
  events.get('keydown')!({ code: 'KeyR', ctrlKey: true, target: { tagName: 'BODY' } });
  assert.equal(input.consumeAppActions().resetFlight, false);
});

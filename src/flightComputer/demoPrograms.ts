import type { StoredProgram } from './examplePrograms';
import type { ScenarioId } from '../simulation/scenarios';

export function returnFlightSource(targetApogeeM: number, landingOnly = false): string {
  return `// REENTRY automatic flight demo — Falcon 9 / REENTRY-9 only.
// ${landingOnly ? 'Start in Near-Ground Landing Practice.' : 'Use AUTO DEMOS to prepare a reusable booster on the launchpad.'}
// Change TARGET_APOGEE_M to customize the sightseeing flight.
// Esc immediately returns control to you. This is game guidance, not real flight software.
const TARGET_APOGEE_M = ${targetApogeeM};
let phase = "${landingOnly ? 'LANDING' : 'ASCENT'}";
let startLat = 0, startLon = 0;
const limit = (x, a, b) => Math.max(a, Math.min(b, x));
function init(api, t) {
  if (!t.vehicle.hasLandingGear || t.vehicle.role === "stack") throw new Error("Use AUTO DEMOS to prepare a reusable REENTRY-9 booster with landing legs.");
  startLat = t.position.latitudeDeg - t.landingTarget.relativeSouthM / 6371000 * 180 / Math.PI;
  startLon = t.position.longitudeDeg + t.landingTarget.relativeEastM / (6371000 * Math.cos(startLat * Math.PI / 180)) * 180 / Math.PI;
  api.setSasMode("VERTICAL");
  api.log("Auto demo armed: ${landingOnly ? 'landing practice' : targetApogeeM / 1000 + ' km launch and return'}.");
}
function changePhase(next, api) {
  if (phase !== next) { phase = next; api.log("Flight phase: " + next); }
}
function update(t, api) {
  const h = t.position.altitudeAGL, v = t.velocity.vertical;
  const g = t.environment.gravityMs2;
  const thrust = 7607000 + 620000 * (1 - limit(t.environment.atmosphericDensity / 1.225, 0, 1));
  const maximumAcceleration = thrust / t.vehicle.massKg;
  api.record("phase", phase);
  api.record("altitude_m", h);

  if (t.vehicle.status === "LANDED" || t.vehicle.status === "CRASHED" || phase === "DONE") {
    api.shutdown(); api.setAttitude(0, 0, 0); api.setSasMode("HOLD");
    if (phase !== "DONE") changePhase(t.vehicle.status === "LANDED" ? "DONE" : "ABORTED", api);
    return;
  }

  let throttle = 0;
  if (phase === "ASCENT") {
    throttle = 1;
    // Cut off using predicted apogee, allowing for engine spool-down.
    const apogee = h + Math.max(0, v) ** 2 / (2 * g) + Math.max(0, v) * 0.3;
    if (h > 30 && apogee >= TARGET_APOGEE_M) changePhase("COAST", api);
  }
  if (phase === "COAST") {
    throttle = 0;
    if (v < -2) changePhase("DESCENT", api);
  }
  if (phase === "DESCENT") {
    const brakeAcceleration = Math.max(1, maximumAcceleration - g);
    const stoppingDistance = Math.max(0, -v) ** 2 / (2 * brakeAcceleration);
    if (h < stoppingDistance * 1.5 + Math.max(220, -v * 1.5)) changePhase("LANDING", api);
  }
  if (phase === "LANDING") {
    api.setLandingGear(true);
    const targetV = -Math.min(110, Math.max(1.7, Math.sqrt(4 * Math.max(0, h - 3))));
    const feedforward = targetV < -1.7 && targetV > -110 ? limit(-2 * v / -targetV, 0, 3) : 0;
    const acceleration = limit(feedforward + (targetV - v) * 0.85, -g, maximumAcceleration - g);
    throttle = limit((g + acceleration) / maximumAcceleration, 0, 1);
    api.record("target_vertical_mps", targetV);
    if (h < 2.8 && v > -4 && v < 1) {
      throttle = 0;
      changePhase("TOUCHDOWN", api);
    }
  }
  if (phase === "TOUCHDOWN") throttle = 0;

  // Return toward LZ-1, clear of the launch tower. Body direction vectors remain
  // well-defined even in vertical flight, where Euler heading is ambiguous.
  const rad = Math.PI / 180;
  const east = (t.position.longitudeDeg - startLon) * rad * 6371000 * Math.cos(startLat * rad);
  const south = (startLat - t.position.latitudeDeg) * rad * 6371000;
  const ax = limit((limit(-east * 0.045, -35, 35) - t.velocity.surfaceLocal.east) * 0.45, -1.6, 1.6);
  const az = limit((limit(-south * 0.045, -35, 35) - t.velocity.surfaceLocal.south) * 0.45, -1.6, 1.6);
  const n = t.attitude.noseLocal, r = t.attitude.rightLocal;
  const nose = [n.x, n.y, n.z], right = [r.x, r.y, r.z];
  const forward = [right[1] * nose[2] - right[2] * nose[1], right[2] * nose[0] - right[0] * nose[2], right[0] * nose[1] - right[1] * nose[0]];
  const target = throttle > 0.01 && h > 80 ? [ax / g, 1, az / g] : [0, 1, 0];
  const dot = a => a.reduce((sum, x, i) => sum + x * target[i], 0);
  const rate = t.attitude.angularVelocityBody;
  api.setSasMode("OFF");
  api.setAttitude(limit(-dot(forward) * 1.8 + rate.x * 4, -0.6, 0.6),
    limit(-dot(right) * 1.8 - rate.z * 4, -0.6, 0.6), limit(rate.y * 4, -0.6, 0.6));
  api.record("return_distance_m", Math.hypot(east, south));
  if (throttle > 0.001) { if (!t.propulsion.engineIgnited) api.ignite(); api.setThrottle(throttle); }
  else api.shutdown();
}
`;
}

export const AUTO_DEMOS: Array<{ id: string; name: string; description: string; scenario: ScenarioId; boosterOnly?: boolean; program: StoredProgram }> = [
  { id: 'hop', name: 'Quick launch & landing', description: 'About a minute: the reusable booster rises to 1 km, coasts, then returns toward LZ-1 and lands automatically.', scenario: 'prelaunch', boosterOnly: true,
    program: { id: 'demo-hop-v1', name: '04_auto_launch_and_land.js', language: 'javascript', isExample: true, updatedAt: 10, code: returnFlightSource(1000) } },
  { id: 'space-return', name: 'Space & return', description: 'A longer vertical sightseeing flight above 100 km, followed by an automatic return and landing. Reusable booster only, with fuel reserved for the return.', scenario: 'prelaunch', boosterOnly: true,
    program: { id: 'demo-space-return-v1', name: '05_auto_space_and_return.js', language: 'javascript', isExample: true, updatedAt: 11, code: returnFlightSource(110000) } },
  { id: 'landing', name: 'Landing preview', description: 'Start 950 m above LZ-1 and watch the booster ignite, deploy its legs and land.', scenario: 'near_ground_landing',
    program: { id: 'demo-landing-v1', name: '06_auto_booster_landing.js', language: 'javascript', isExample: true, updatedAt: 12, code: returnFlightSource(0, true) } },
];

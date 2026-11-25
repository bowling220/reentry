import type { StoredProgram } from './examplePrograms';

export function coastalFlightSource(returnHome = false): string {
  return `// Coastal sightseeing flight — reusable REENTRY-9 booster.
// Use AUTO DEMOS > Coastal cruise. RETURN HOME can interrupt the trip at any time.
// Waypoint is about 4 km along the coast; home is the LZ-1 landing pad.
let phase = "${returnHome ? 'RETURN' : 'CLIMB'}";
let cruiseAltitude = 1800, holdStarted = 0;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function init(api, t) {
  if (t.vehicle.role !== "booster" || !t.vehicle.hasLandingGear) throw new Error("Use the coastal booster demo.");
  ${returnHome ? 'cruiseAltitude = clamp(t.position.altitudeAGL, 1800, 2200);' : ''}
  api.log("${returnHome ? 'Return home engaged: flying to LZ-1, then landing.' : 'Coastal tour started. Press RETURN HOME whenever you are ready.'}");
}
function enter(next, api) {
  if (phase !== next) { phase = next; api.log("Coastal flight: " + next); }
}
function update(t, api) {
  const h = t.position.altitudeAGL, v = t.velocity.vertical, g = t.environment.gravityMs2;
  const east = -t.landingTarget.relativeEastM, south = -t.landingTarget.relativeSouthM;
  const vx = t.velocity.surfaceLocal.east, vz = t.velocity.surfaceLocal.south;
  const speed = Math.hypot(vx, vz), homeDistance = Math.hypot(east, south);
  api.record("phase", phase);
  api.record("home_distance_m", homeDistance);
  api.record("altitude_m", h);
  if (phase === "DONE" || t.vehicle.status === "LANDED" || t.vehicle.status === "CRASHED") {
    api.shutdown(); api.setSasMode("HOLD"); api.setAttitude(0, 0, 0);
    if (phase !== "DONE") enter("DONE", api);
    return;
  }
  if (phase === "CLIMB" && h > 180) enter("OUTBOUND", api);
  const waypointDistance = Math.hypot(600 - east, 4000 - south);
  if (phase === "OUTBOUND" && waypointDistance < 80 && speed < 8 && Math.abs(h - cruiseAltitude) < 80) {
    holdStarted = t.simTime; enter("HOLD", api);
    api.log("Waypoint reached. Press RETURN HOME; automatic fuel protection returns after a short hold.");
  }
  if ((phase === "OUTBOUND" || phase === "HOLD") &&
      (t.vehicle.propellantFraction < 0.35 || (phase === "HOLD" && t.simTime - holdStarted > 90))) enter("RETURN", api);
  if (phase === "RETURN" && homeDistance < 35 && speed < 2 &&
      h > cruiseAltitude - 60 && Math.abs(v) < 5) enter("LANDING", api);

  let targetEast = 0, targetSouth = 0;
  if (phase === "CLIMB") { targetEast = 320; targetSouth = -520; }
  else if (phase === "OUTBOUND" || phase === "HOLD") { targetEast = 600; targetSouth = 4000; }
  const maxSpeed = phase === "LANDING" ? Math.min(25, Math.max(2, Math.sqrt(h))) : 65;
  let targetVx = (targetEast - east) * 0.06, targetVz = (targetSouth - south) * 0.06;
  const velocityScale = Math.min(1, maxSpeed / Math.max(0.001, Math.hypot(targetVx, targetVz)));
  targetVx *= velocityScale; targetVz *= velocityScale;
  let ax = clamp((targetVx - vx) * 0.35, -2.2, 2.2);
  let az = clamp((targetVz - vz) * 0.35, -2.2, 2.2);
  const thrust = 7607000 + 620000 * (1 - clamp(t.environment.atmosphericDensity / 1.225, 0, 1));
  const maxAcceleration = thrust / t.vehicle.massKg;
  let desiredV = clamp((cruiseAltitude - h) * 0.12, -40, 60);
  let feedforward = 0;
  if (phase === "LANDING") {
    desiredV = -Math.min(55, Math.max(1.7, Math.sqrt(4 * Math.max(0, h - 3))));
    feedforward = desiredV < -1.7 && desiredV > -55 ? clamp(-2 * v / -desiredV, 0, 3) : 0;
    if (h < 350) api.setLandingGear(true);
    if (h < 2.8 && v > -4 && v < 1) enter("TOUCHDOWN", api);
  }
  const verticalAcceleration = clamp(feedforward + (desiredV - v) * 0.85, -g, maxAcceleration - g);
  const support = Math.max(1, g + verticalAcceleration);
  let throttle = clamp(support / (maxAcceleration * Math.max(0.85, t.attitude.noseLocal.y)), 0, 1);
  if (phase === "TOUCHDOWN") throttle = 0;
  const n = t.attitude.noseLocal, r = t.attitude.rightLocal;
  const forward = [r.y * n.z - r.z * n.y, r.z * n.x - r.x * n.z, r.x * n.y - r.y * n.x];
  const target = h > 80 ? [ax / support, 1, az / support] : [0, 1, 0];
  const targetRight = r.x * target[0] + r.y * target[1] + r.z * target[2];
  const targetForward = forward[0] * target[0] + forward[1] * target[1] + forward[2] * target[2];
  const rate = t.attitude.angularVelocityBody;
  api.setSasMode("OFF");
  api.setAttitude(clamp(-targetForward * 1.8 + rate.x * 4, -0.6, 0.6),
    clamp(-targetRight * 1.8 - rate.z * 4, -0.6, 0.6), clamp(rate.y * 4, -0.6, 0.6));
  api.record("target_vertical_mps", desiredV);
  if (throttle > 0.001) { if (!t.propulsion.engineIgnited) api.ignite(); api.setThrottle(throttle); }
  else api.shutdown();
}
`;
}

export const COASTAL_PROGRAM: StoredProgram = {
  id: 'demo-coastal-v1', name: '07_coastal_cruise.js', language: 'javascript', isExample: true,
  updatedAt: 13, code: coastalFlightSource(),
};
export const RETURN_HOME_PROGRAM: StoredProgram = {
  id: 'demo-return-home-v1', name: '08_return_home.js', language: 'javascript', isExample: true,
  updatedAt: 14, code: coastalFlightSource(true),
};

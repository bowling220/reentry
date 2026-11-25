import type { StoredProgram } from './examplePrograms';

/** Runs through the same sandbox/validated controls as player-written programs. */
export const ADAPTIVE_RETURN_PROGRAM: StoredProgram = {
  id: 'adaptive-return-v1', name: '09_adaptive_return_home.js', language: 'javascript', isExample: true, updatedAt: 15,
  code: `// Adaptive return guidance: uses this vehicle's actual remaining propellant.
// No fuel refill, position reset, or teleport. Esc gives control back to the pilot.
let mode = "HOME", phase = "ASSESS", cruise = 1800, speedLimit = 65;
let localEast = 0, localSouth = 0, lastAssessment = -10;
let pulseOn = false;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function assess(t, distance, altitude) {
  const mass = t.vehicle.massKg, dry = Math.max(1, mass - t.vehicle.propellantKg);
  const dv = t.propulsion.specificImpulseS * 9.80665 * Math.log(mass / dry);
  const g = t.environment.gravityMs2, acceleration = t.propulsion.availableThrustN / mass;
  const horizontal = Math.hypot(t.velocity.surfaceLocal.east, t.velocity.surfaceLocal.south);
  const lateralAcceleration = clamp((acceleration - g) * 0.25, 0.8, t.vehicle.role === "stack" ? 1.2 : 2.2);
  const effectiveDistance = distance + horizontal * horizontal / (2 * lateralAcceleration);
  const speed = clamp(Math.sqrt(Math.max(1, effectiveDistance) * lateralAcceleration) * 0.85, 30, t.vehicle.role === "stack" ? 45 : 180);
  const travelTime = effectiveDistance / speed + speed / lateralAcceleration;
  const landing = 80 + Math.sqrt(t.velocity.vertical ** 2 + 2 * g * Math.max(0, t.position.altitudeAGL)) * 0.9;
  const climb = Math.max(0, altitude - t.position.altitudeAGL);
  const climbCost = climb > 100 ? Math.sqrt(2 * g * climb) + g * climb / 50 : 0;
  return { dv, needed: landing + horizontal + speed + 1.25 * g * travelTime + climbCost, landing, speed };
}
function change(next, api) {
  if (phase !== next) { phase = next; api.log("Recovery: " + phase); }
}
function chooseLocal(t, api, reason) {
  mode = t.vehicle.propellantKg > 0 ? "LOCAL_LANDING" : "UNPOWERED";
  localEast = -t.landingTarget.relativeEastM;
  localSouth = -t.landingTarget.relativeSouthM;
  api.log(reason + ". Attempting a local landing with the remaining fuel.");
  api.record("return_reason", reason);
}
function init(api, t) {
  if (!t.vehicle.hasLandingGear || t.propulsion.availableThrustN <= 0) throw new Error("Recovery requires an engine and landing legs.");
  const twr = t.propulsion.availableThrustN / (t.vehicle.massKg * t.environment.gravityMs2);
  cruise = clamp(t.position.altitudeAGL, twr < 6 ? 1800 : 350, 2200);
  const budget = assess(t, t.landingTarget.distanceM, cruise);
  speedLimit = Math.min(budget.speed, t.vehicle.role === "stack" ? 45 : 180);
  if (budget.dv < budget.needed || t.vehicle.propellantKg <= 0) chooseLocal(t, api, "Home exceeds the estimated fuel budget");
  change(t.position.altitudeAGL > cruise + 3000 || t.velocity.vertical < -150 ? "COAST" : (mode === "HOME" ? "TRANSIT" : "LANDING"), api);
  api.record("return_mode", mode);
  api.log(mode === "HOME" ? "Return home planned from current position, velocity and fuel." : "Home is outside the conservative recovery budget.");
}
function update(t, api) {
  const h = t.position.altitudeAGL, v = t.velocity.vertical, g = t.environment.gravityMs2;
  const east = -t.landingTarget.relativeEastM, south = -t.landingTarget.relativeSouthM;
  const vx = t.velocity.surfaceLocal.east, vz = t.velocity.surfaceLocal.south;
  const horizontal = Math.hypot(vx, vz), distance = Math.hypot(east, south);
  const maxAcceleration = t.propulsion.availableThrustN / Math.max(1, t.vehicle.massKg);
  const netAcceleration = Math.max(0.5, maxAcceleration - g);
  if (t.vehicle.status === "LANDED" || t.vehicle.status === "CRASHED" || phase === "DONE") {
    api.shutdown(); api.setAttitude(0, 0, 0); api.setSasMode("HOLD");
    change("DONE", api); api.record("phase", phase); return;
  }
  if (t.simTime - lastAssessment > 1) {
    lastAssessment = t.simTime;
    const budget = assess(t, distance, cruise);
    api.record("available_dv_mps", Math.round(budget.dv));
    api.record("required_dv_mps", Math.round(budget.needed));
    if (mode === "HOME" && phase !== "LANDING" && phase !== "TOUCHDOWN" && budget.dv < budget.needed * 0.72) {
      chooseLocal(t, api, "Fuel reserve no longer covers the homeward route");
      if (phase === "TRANSIT") change("LANDING", api);
    }
  }
  if (t.vehicle.propellantKg <= 0 && mode !== "UNPOWERED") {
    mode = "UNPOWERED"; api.record("return_reason", "Propellant exhausted; powered recovery unavailable");
  }
  const targetAltitude = mode === "HOME" ? cruise : 0;
  if (phase === "COAST" && v < 0 &&
      h < targetAltitude + v * v / (2 * netAcceleration) * 1.45 + Math.max(500, -v * 1.5)) change("BRAKE", api);
  if (phase === "BRAKE" && mode === "HOME" && h < cruise + 70 && Math.abs(v) < 10) change("TRANSIT", api);
  if (phase === "BRAKE" && mode !== "HOME" && h < 800) change("LANDING", api);
  if (phase === "TRANSIT" && distance < 15 && horizontal < 0.8 && h > cruise - 60 && Math.abs(v) < 3) change("LANDING", api);

  const targetEast = mode === "HOME" ? 0 : localEast;
  const targetSouth = mode === "HOME" ? 0 : localSouth;
  const dx = targetEast - east, dz = targetSouth - south, range = Math.hypot(dx, dz);
  const lateralLimit = clamp(netAcceleration * 0.25, 0.8, t.vehicle.role === "stack" ? 1.2 : 2.2);
  let desiredSpeed = Math.min(speedLimit, range * 0.06);
  if (phase === "LANDING") desiredSpeed = Math.min(desiredSpeed, Math.max(2, Math.sqrt(h)));
  const targetVx = range > 0.1 ? dx / range * desiredSpeed : 0;
  const targetVz = range > 0.1 ? dz / range * desiredSpeed : 0;
  let ax = clamp((targetVx - vx) * 0.35, -lateralLimit, lateralLimit);
  let az = clamp((targetVz - vz) * 0.35, -lateralLimit, lateralLimit);
  let desiredV = clamp((targetAltitude - h) * 0.12, -60, 60), feedforward = 0;
  if (phase === "BRAKE") {
    const braking = Math.min(8, netAcceleration * 0.4);
    desiredV = -Math.min(250, Math.sqrt(2 * braking * Math.max(0, h - targetAltitude)));
    if (desiredV < -5 && desiredV > -250) feedforward = clamp(-braking * v / -desiredV, 0, braking * 1.5);
  }
  if (phase === "LANDING") {
    desiredV = -Math.min(55, Math.max(1.7, Math.sqrt(4 * Math.max(0, h - 3))));
    if (desiredV < -1.7 && desiredV > -55) feedforward = clamp(-2 * v / -desiredV, 0, 3);
    if (h < 400) api.setLandingGear(true);
    if (h < 2.8 && v > -4 && v < 1) change("TOUCHDOWN", api);
  }
  const acceleration = clamp(feedforward + (desiredV - v) * 0.85, -g, netAcceleration);
  const support = Math.max(1, g + acceleration);
  const n = t.attitude.noseLocal, r = t.attitude.rightLocal, rate = t.attitude.angularVelocityBody;
  let throttle = clamp(support / (maxAcceleration * Math.max(0.8, n.y)), 0, 1);
  const coast = phase === "COAST" || mode === "UNPOWERED";
  const target = h > 80 && !coast ? [ax / support, 1, az / support] : [0, 1, 0];
  const forward = [r.y * n.z - r.z * n.y, r.z * n.x - r.x * n.z, r.x * n.y - r.y * n.x];
  let targetForward = forward[0] * target[0] + forward[1] + forward[2] * target[2];
  const targetRight = r.x * target[0] + r.y + r.z * target[2];
  if (n.y < -0.7 && Math.abs(targetForward) < 0.1 && Math.abs(targetRight) < 0.1) targetForward = 0.5;
  // Right an off-axis vehicle before applying substantial main-engine thrust.
  if (n.y < 0.65 || Math.hypot(rate.x, rate.z) > 0.6) throttle = 0;
  if (coast || phase === "TOUCHDOWN") throttle = 0;
  api.setSasMode("OFF");
  const damping = t.vehicle.role === "stack" ? 9 : 4;
  api.setAttitude(clamp(-targetForward * 1.8 + rate.x * damping, -0.6, 0.6),
    clamp(-targetRight * 1.8 - rate.z * damping, -0.6, 0.6), clamp(rate.y * damping, -0.6, 0.6));
  // Engines cannot command below their physical minimum; pulse short burns instead.
  if (throttle > 0 && throttle < t.propulsion.minimumThrottle) {
    if (t.propulsion.throttle < throttle * 0.8) pulseOn = true;
    if (t.propulsion.throttle > throttle * 1.2) pulseOn = false;
    throttle = pulseOn ? t.propulsion.minimumThrottle : 0;
  }
  if (throttle > 0.001) { if (!t.propulsion.engineIgnited) api.ignite(); api.setThrottle(throttle); }
  else api.shutdown();
  if (mode === "UNPOWERED") api.setLandingGear(true);
  api.record("phase", phase); api.record("return_mode", mode);
  api.record("home_distance_m", distance); api.record("target_vertical_mps", desiredV);
}
`,
};

import { ProgramLanguage } from './apiTypes';

export interface StoredProgram {
  id: string;
  name: string;
  language: ProgramLanguage;
  code: string;
  updatedAt: number;
  isExample?: boolean;
}

export const EXAMPLE_PROGRAMS: StoredProgram[] = [
  {
    id: 'ex-js-telemetry',
    name: '01_telemetry_logger.js',
    language: 'javascript',
    isExample: true,
    updatedAt: 1,
    code: `// REENTRY Flight Computer — Beginner Starter (JavaScript)
// Reads simulated spacecraft telemetry, records custom variables,
// and reacts to virtual flight events without taking over throttle.

let maxAltKm = 0;
let lastLogMet = -5;

function init(api) {
  api.log("Telemetry Logger initialized (API v" + api.version + ")");
  api.setSasMode("HOLD");
}

function update(t, api) {
  const altKm = t.position.altitudeASL / 1000;
  if (altKm > maxAltKm) maxAltKm = altKm;

  // Record custom variables to inspect & plot in the Telemetry Graphs tab
  api.record("max_alt_km", Number(maxAltKm.toFixed(2)));
  api.record("q_kpa", Number((t.environment.dynamicPressurePa / 1000).toFixed(2)));

  if (t.met - lastLogMet >= 5) {
    lastLogMet = t.met;
    api.log(
      "MET " + t.met.toFixed(1) + "s | ALT " + altKm.toFixed(2) + " km | " +
      "VEL " + t.velocity.surfaceSpeed.toFixed(0) + " m/s | " + t.orbit.classification
    );
  }
}

function onEvent(name, payload, t, api) {
  api.log("EVENT [" + name.toUpperCase() + "] at ALT " + (t.position.altitudeASL / 1000).toFixed(2) + " km");
}
`,
  },
  {
    id: 'ex-js-launch',
    name: '02_launch_ascent_starter.js',
    language: 'javascript',
    isExample: true,
    updatedAt: 2,
    code: `// REENTRY Flight Computer — Automated Ascent & Staging Starter (JS)
// For educational gameplay inside REENTRY's simplified physics model.
// Try running this from the "Cape Canaveral Prelaunch" scenario!

let phase = "IGNITION";

function init(api) {
  api.log("Ascent guidance armed. Starting ignition sequence...");
  api.setSasMode("HOLD");
}

function update(t, api) {
  const altM = t.position.altitudeASL;
  const fuelPct = t.vehicle.propellantFraction * 100;

  api.record("phase", phase);
  api.record("fuel_pct", Number(fuelPct.toFixed(1)));

  if (phase === "IGNITION") {
    api.ignite();
    api.setThrottle(1.0);
    if (altM > 180) {
      phase = "PITCH_OVER";
      api.log("Tower cleared — beginning gentle downrange pitch program.");
    }
    return;
  }

  if (phase === "PITCH_OVER") {
    api.setThrottle(1.0);
    // Gentle game-oriented gravity turn pitch-down as altitude climbs
    const targetPitch = Math.max(22, 90 - (altM / 65000) * 68);
    const pitchErr = targetPitch - t.attitude.pitchDeg;
    api.record("target_pitch", Number(targetPitch.toFixed(1)));
    api.setYaw(Math.max(-0.45, Math.min(0.45, -pitchErr * 0.03)));

    // Reserve ~12% booster fuel, then execute Stage 1 MECO + separation!
    if (fuelPct <= 14 && t.vehicle.canStage) {
      api.shutdown();
      api.stage();
      phase = "STAGE2_COAST";
      api.log("MECO & Stage 1 separation requested!");
    }
    return;
  }

  if (phase === "STAGE2_COAST") {
    api.setSasMode("HOLD");
    if (t.vehicle.role === "upper_stage") {
      api.ignite();
      api.setThrottle(1.0);
      phase = "STAGE2_BURN";
      api.log("Stage 2 MVac ignited for orbital climb!");
    }
    return;
  }

  if (phase === "STAGE2_BURN") {
    const apKm = (t.orbit.apoapsisM ?? 0) / 1000;
    api.record("apoapsis_km", Number(apKm.toFixed(1)));
    if (apKm >= 220) {
      api.shutdown();
      phase = "SECO";
      api.log("Target apoapsis reached (" + apKm.toFixed(1) + " km) — SECO!");
    }
  }
}

function onEvent(name, payload, t, api) {
  api.log("Flight Event: " + name);
}
`,
  },
  {
    id: 'ex-js-landing',
    name: '03_booster_landing_practice.js',
    language: 'javascript',
    isExample: true,
    updatedAt: 3,
    code: `// REENTRY Flight Computer — Near-Ground Booster Landing Practice (JS)
// Load the "Near-Ground Landing Practice" scenario and press RUN!
// Demonstrates simplified vertical velocity control & landing gear deployment.

let landed = false;

function init(api) {
  api.log("Booster vertical landing controller armed.");
  api.setSasMode("VERTICAL");
}

function update(t, api) {
  if (landed || t.vehicle.status === "LANDED" || t.vehicle.status === "CRASHED") {
    api.shutdown();
    return;
  }

  const agl = t.position.altitudeAGL;
  const vz = t.velocity.vertical; // negative while descending

  // Deploy landing legs below 260 m AGL
  if (agl < 260 && t.vehicle.hasLandingGear && !t.controls.gearDeployed) {
    api.setLandingGear(true);
    api.log("Deploying landing legs at " + agl.toFixed(0) + " m AGL.");
  }

  // Keep booster upright using VERTICAL SAS near touchdown, RETROGRADE higher up
  api.setSasMode(agl < 220 ? "VERTICAL" : "RETROGRADE");

  // Target descent speed slows smoothly as ground approaches
  const targetVz = agl > 250 ? -55 : -Math.max(2.2, Math.sqrt(Math.max(0, agl)) * 1.45);
  const vzError = targetVz - vz; // positive when falling faster than target

  // Estimate hover throttle (mg / maxThrust approx)
  const hoverThr = (t.vehicle.massKg * t.environment.gravityMs2) / 7607000;
  const cmdThr = Math.max(0, Math.min(1, hoverThr + vzError * 0.045));

  api.record("target_vz", Number(targetVz.toFixed(1)));
  api.record("cmd_throttle", Number(cmdThr.toFixed(3)));

  if (agl < 2.2 && Math.abs(vz) < 2.5) {
    api.shutdown();
    landed = true;
    api.log("Touchdown cutoff!");
  } else if (cmdThr > 0.04) {
    api.ignite();
    api.setThrottle(cmdThr);
  } else {
    api.shutdown();
  }
}

function onEvent(name, payload, t, api) {
  if (name === "touchdown") {
    landed = true;
    api.shutdown();
    api.log("Booster touchdown confirmed!");
  }
}
`,
  },
  {
    id: 'ex-py-telemetry',
    name: '01_telemetry_monitor.py',
    language: 'python',
    isExample: true,
    updatedAt: 4,
    code: `# REENTRY Flight Computer — Beginner Python Starter
# Runs inside an isolated lazy-loaded Python (Pyodide) sandbox.
# Note: Python loads on demand the first time you run a .py program.

import math

max_alt_km = 0.0
last_log = -5.0

def init(api):
    api.log(f"Python Telemetry Monitor ready (API v{api.version})")
    api.set_sas_mode("HOLD")

def update(t, api):
    global max_alt_km, last_log
    alt_km = t.position.altitudeASL / 1000.0
    if alt_km > max_alt_km:
        max_alt_km = alt_km

    api.record("max_alt_km", round(max_alt_km, 2))
    api.record("mach", round(t.velocity.mach, 2))

    if t.met - last_log >= 5.0:
        last_log = t.met
        ap = t.orbit.apoapsisM
        ap_str = f"{ap/1000.0:.1f} km" if ap is not None else "N/A"
        api.log(
            f"MET {t.met:.1f}s | ALT {alt_km:.2f} km | "
            f"V={t.velocity.surfaceSpeed:.0f} m/s | AP={ap_str}"
        )

def on_event(name, payload, t, api):
    api.log(f"EVENT [{name.upper()}] at {t.position.altitudeASL/1000.0:.2f} km")
`,
  },
  {
    id: 'ex-py-ascent',
    name: '02_python_ascent.py',
    language: 'python',
    isExample: true,
    updatedAt: 5,
    code: `# REENTRY Flight Computer — Python Ascent & Staging Starter
# Demonstrates stateful Python guidance, telemetry recording, and staging.

stage_phase = "LAUNCH"

def init(api):
    api.log("Python Ascent Controller initialized.")
    api.set_sas_mode("HOLD")

def update(t, api):
    global stage_phase
    alt = t.position.altitudeASL
    fuel_pct = t.vehicle.propellantFraction * 100.0
    api.record("phase", stage_phase)
    api.record("fuel_pct", round(fuel_pct, 1))

    if stage_phase == "LAUNCH":
        api.ignite()
        api.set_throttle(1.0)
        if alt > 200.0:
            stage_phase = "GRAVITY_TURN"
            api.log("Cleared tower — starting Python ascent pitch curve.")

    elif stage_phase == "GRAVITY_TURN":
        api.set_throttle(1.0)
        target_pitch = max(25.0, 90.0 - (alt / 65000.0) * 65.0)
        err = target_pitch - t.attitude.pitchDeg
        api.record("target_pitch", round(target_pitch, 1))
        api.set_yaw(max(-0.4, min(0.4, -err * 0.03)))

        if fuel_pct <= 14.0 and t.vehicle.canStage:
            api.shutdown()
            api.stage()
            stage_phase = "UPPER_IGNITE"
            api.log("Booster reserve reached — staging Stage 1!")

    elif stage_phase == "UPPER_IGNITE":
        if t.vehicle.role == "upper_stage":
            api.ignite()
            api.set_throttle(1.0)
            stage_phase = "ORBIT_CLIMB"
            api.log("Upper stage MVac burning!")

    elif stage_phase == "ORBIT_CLIMB":
        ap = t.orbit.apoapsisM or 0.0
        api.record("apoapsis_km", round(ap / 1000.0, 1))
        if ap >= 220000.0:
            api.shutdown()
            stage_phase = "COAST"
            api.log("SECO — coasting toward apoapsis.")

def on_event(name, payload, t, api):
    api.log(f"Event received: {name}")
`,
  },
  {
    id: 'ex-py-landing',
    name: '03_python_booster_landing.py',
    language: 'python',
    isExample: true,
    updatedAt: 6,
    code: `# REENTRY Flight Computer — Python Booster Landing Practice
# Try with the "Near-Ground Landing Practice" scenario!

import math

touchdown_done = False

def init(api):
    api.log("Python Booster Landing Controller armed.")
    api.set_sas_mode("VERTICAL")

def update(t, api):
    global touchdown_done
    if touchdown_done or t.vehicle.status in ("LANDED", "CRASHED"):
        api.shutdown()
        return

    agl = t.position.altitudeAGL
    vz = t.velocity.vertical

    if agl < 260.0 and t.vehicle.hasLandingGear and not t.controls.gearDeployed:
        api.set_landing_gear(True)
        api.log(f"Gear down at {agl:.0f} m AGL.")

    api.set_sas_mode("VERTICAL" if agl < 220.0 else "RETROGRADE")

    target_vz = -55.0 if agl > 250.0 else -max(2.2, math.sqrt(max(0.0, agl)) * 1.45)
    err = target_vz - vz
    hover_thr = (t.vehicle.massKg * t.environment.gravityMs2) / 7607000.0
    thr = max(0.0, min(1.0, hover_thr + err * 0.045))

    api.record("target_vz", round(target_vz, 1))
    api.record("cmd_thr", round(thr, 3))

    if agl < 2.2 and abs(vz) < 2.5:
        api.shutdown()
        touchdown_done = True
    elif thr > 0.04:
        api.ignite()
        api.set_throttle(thr)
    else:
        api.shutdown()

def on_event(name, payload, t, api):
    global touchdown_done
    if name == "touchdown":
        touchdown_done = True
        api.shutdown()
        api.log("Python controller: touchdown confirmed!")
`,
  },
];

export const API_DOCUMENTATION_HTML = `
  <div class="doc-section">
    <h4>REENTRY Simulated Flight API (v1.0.0)</h4>
    <p>Programs run inside an isolated sandbox (QuickJS-WASM for JavaScript, locked-down Pyodide Worker for Python) at fixed simulation-time intervals (default 10 Hz). Commands are validated and constrained by spacecraft physics.</p>
  </div>
  <div class="doc-section">
    <h5>Program Lifecycle Callbacks</h5>
    <ul>
      <li><code>init(api, telemetry)</code> — Called once when you click <strong>RUN</strong>. Initialize state here.</li>
      <li><code>update(telemetry, api)</code> — Called at fixed simulation rate (e.g. 10 Hz). Read telemetry &amp; issue commands.</li>
      <li><code>onEvent(name, payload, telemetry, api)</code> (Python: <code>on_event</code>) — Fired on <code>liftoff</code>, <code>ignition</code>, <code>shutdown</code>, <code>staging</code>, <code>touchdown</code>, <code>destroyed</code>, <code>orbit_achieved</code>.</li>
    </ul>
  </div>
  <div class="doc-section">
    <h5>Validated Control Commands (<code>api</code>)</h5>
    <ul>
      <li><code>setThrottle(0..1)</code> / <code>set_throttle(v)</code> — Command engine throttle.</li>
      <li><code>ignite()</code> / <code>shutdown()</code> — Request engine start or cutoff.</li>
      <li><code>setPitch(v)</code>, <code>setYaw(v)</code>, <code>setRoll(v)</code>, <code>setAttitude(p,y,r)</code> — Attitude torque request in <code>[-1, 1]</code>.</li>
      <li><code>setSasMode("OFF"|"HOLD"|"RETROGRADE"|"VERTICAL")</code> — Select stability assist.</li>
      <li><code>setLandingGear(bool)</code> / <code>set_landing_gear(bool)</code> — Deploy/retract booster legs.</li>
      <li><code>stage()</code> — Request next stage separation / fairing jettison / payload deploy.</li>
      <li><code>log(...)</code>, <code>warn(...)</code>, <code>error(...)</code> — Write to the Flight Computer console.</li>
      <li><code>record(key, value)</code> — Track custom variables in Inspector &amp; Telemetry Graphs.</li>
    </ul>
  </div>
  <div class="doc-section">
    <h5>Read-Only Telemetry Structure (<code>t</code>)</h5>
    <ul>
      <li><code>t.simTime</code>, <code>t.met</code>, <code>t.dt</code></li>
      <li><code>t.vehicle</code>: <code>id, name, role, status, massKg, propellantKg, propellantFraction, hasLandingGear, canStage</code></li>
      <li><code>t.position</code>: <code>altitudeASL, altitudeAGL, latitudeDeg, longitudeDeg, distanceFromPadM</code></li>
      <li><code>t.velocity</code>: <code>vertical, horizontal, surfaceSpeed, inertialSpeed, mach, surfaceLocal.{east,up,south}</code></li>
      <li><code>t.attitude</code>: <code>pitchDeg, headingDeg, rollDeg, tiltFromVerticalDeg, angularVelocityBody.{x,y,z}</code></li>
      <li><code>t.propulsion</code>: <code>engineIgnited, throttle, thrustN</code></li>
      <li><code>t.environment</code>: <code>atmosphericDensity, dynamicPressurePa, gravityMs2, inSpace, reentryHeat</code></li>
      <li><code>t.orbit</code>: <code>valid, classification, apoapsisM, periapsisM, inclinationDeg, eccentricity, periodS, timeToApoapsisS, timeToPeriapsisS</code></li>
      <li><code>t.landingTarget</code>: <code>name, distanceM, relativeEastM, relativeSouthM, elevationM</code></li>
    </ul>
  </div>
  <div class="doc-section">
    <h5>Control Authority &amp; Safety</h5>
    <p>Press <strong>MANUAL OVERRIDE</strong> (or <code>Esc</code>) at any time to immediately reclaim manual control, even if a program stalls or faults. Programs exceeding time/memory limits transition automatically to <code>FAULT</code> (throttle cut, neutral stick, SAS HOLD).</p>
  </div>
`;

import { PLANET_CONFIG } from '../config/planetConfig';
import {
  RAD2DEG,
  Vec3d,
  addVec3,
  clamp,
  crossVec3,
  dotVec3,
  lenVec3,
  normVec3,
  scaleVec3,
  subVec3,
} from '../math/vec3d';
import { FlightStatus } from './flightDynamics';

export type TrajectoryClassification =
  | 'PRELAUNCH'
  | 'ATMOSPHERIC'
  | 'SUBORBITAL'
  | 'ORBITAL'
  | 'ESCAPE'
  | 'REENTRY'
  | 'LANDED'
  | 'DESTROYED';

export interface OrbitalElements {
  /** Whether inertial state yields meaningful two-body orbital parameters */
  valid: boolean;
  /** Apoapsis altitude above mean Earth radius (m), or null on escape trajectories */
  apoapsisAltM: number | null;
  /** Periapsis altitude above mean Earth radius (m) */
  periapsisAltM: number | null;
  /** Semi-major axis (m) */
  semiMajorAxisM: number | null;
  /** Orbital eccentricity (0 = circular, <1 = elliptical, >=1 = escape) */
  eccentricity: number | null;
  /** Inclination relative to Earth's equatorial plane (degrees, 0..180) */
  inclinationDeg: number | null;
  /** Orbital period (seconds), or null if non-elliptical */
  periodS: number | null;
  /** Seconds until next apoapsis, or null if hyperbolic / invalid */
  timeToApoapsisS: number | null;
  /** Seconds until next periapsis, or null if invalid */
  timeToPeriapsisS: number | null;
  /** Specific orbital energy (J/kg) */
  specificEnergyJkg: number;
  /** True anomaly (radians, 0..2pi) */
  trueAnomalyRad: number;
  /** Inertial position vector in ECI (m) */
  posECI: Vec3d;
  /** Inertial velocity vector in ECI (m/s) */
  velECI: Vec3d;
  /** Inertial speed magnitude (m/s) */
  inertialSpeedMs: number;
  /** Specific angular momentum vector in ECI */
  hVecECI: Vec3d;
  /** Eccentricity vector in ECI (points toward periapsis) */
  eVecECI: Vec3d;
  /** Apoapsis point in ECI (m), null for escape */
  apoapsisECI: Vec3d | null;
  /** Periapsis point in ECI (m), null if degenerate */
  periapsisECI: Vec3d | null;
  /** High-level trajectory classification */
  classification: TrajectoryClassification;
}

export interface PredictedTrajectory {
  /** Sampled trajectory points in current ECEF frame (for rendering on 3D map) */
  pointsECEF: Vec3d[];
  /** Projected ground-track points on Earth's surface in ECEF */
  groundTrackECEF: Vec3d[];
  /** Apoapsis point in current ECEF (if visible above surface and elliptical) */
  apoapsisECEF: Vec3d | null;
  /** Periapsis point in current ECEF (if above surface) */
  periapsisECEF: Vec3d | null;
  /** Predicted surface intersection point in ECEF (for suborbital / reentry trajectories) */
  impactECEF: Vec3d | null;
  /** True if orbit closes without hitting Earth */
  isClosedOrbit: boolean;
}

/**
 * Rotate a 3D vector around Earth's +Y spin axis by angleRad.
 */
export function rotateAroundY(v: Vec3d, angleRad: number): Vec3d {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return {
    x: v.x * c + v.z * s,
    y: v.y,
    z: -v.x * s + v.z * c,
  };
}

/**
 * Convert ECEF (Earth-Fixed) position & velocity to ECI (Earth-Centered Inertial).
 * Note: Earth rotates around +Y at omega = +7.2921159e-5 rad/s (eastward).
 */
export function ecefToECI(
  posECEF: Vec3d,
  velECEF: Vec3d,
  earthRotationRad: number
): { posECI: Vec3d; velECI: Vec3d } {
  const omega: Vec3d = { x: 0, y: PLANET_CONFIG.rotationRateRadPerSec, z: 0 };
  const rotVelECEF = crossVec3(omega, posECEF);
  const vInertialInECEF = addVec3(velECEF, rotVelECEF);
  return {
    posECI: rotateAroundY(posECEF, earthRotationRad),
    velECI: rotateAroundY(vInertialInECEF, earthRotationRad),
  };
}

/**
 * Convert an ECI position back to ECEF at a given Earth sidereal rotation angle.
 */
export function eciPosToECEF(posECI: Vec3d, earthRotationRad: number): Vec3d {
  return rotateAroundY(posECI, -earthRotationRad);
}

/**
 * Compute two-body Keplerian orbital elements and trajectory classification from live ECEF state.
 */
export function computeOrbitalElements(
  posECEF: Vec3d,
  velECEF: Vec3d,
  earthRotationRad: number,
  flightStatus: FlightStatus,
  altitudeASLM: number,
  verticalVelMs: number
): OrbitalElements {
  const mu = PLANET_CONFIG.mu;
  const R = PLANET_CONFIG.meanRadiusM;
  const { posECI, velECI } = ecefToECI(posECEF, velECEF, earthRotationRad);

  const rMag = lenVec3(posECI);
  const vMag = lenVec3(velECI);
  const specificEnergy = 0.5 * vMag * vMag - mu / Math.max(1000, rMag);

  const hVec = crossVec3(posECI, velECI);
  const hMag = lenVec3(hVec);

  // Eccentricity vector: e = (v x h)/mu - r/|r|
  const vCrossH = crossVec3(velECI, hVec);
  const eVec = subVec3(scaleVec3(vCrossH, 1 / mu), scaleVec3(posECI, 1 / Math.max(1000, rMag)));
  const ecc = lenVec3(eVec);

  // Handle stationary / prelaunch / landed / crashed states without bogus orbital figures
  if (flightStatus === 'CRASHED') {
    return invalidElements('DESTROYED', posECI, velECI, vMag, specificEnergy, hVec, eVec);
  }
  if (flightStatus === 'PRELAUNCH') {
    return invalidElements('PRELAUNCH', posECI, velECI, vMag, specificEnergy, hVec, eVec);
  }
  if (flightStatus === 'LANDED') {
    return invalidElements('LANDED', posECI, velECI, vMag, specificEnergy, hVec, eVec);
  }

  // Inclination: angle between angular momentum vector h and North Pole (+Y)
  const inclinationDeg =
    hMag > 1e-3 ? Math.acos(clamp(hVec.y / hMag, -1, 1)) * RAD2DEG : 0;

  // True anomaly nu
  let trueAnomalyRad = 0;
  if (ecc > 1e-5) {
    const cosNu = clamp(dotVec3(eVec, posECI) / (ecc * rMag), -1, 1);
    trueAnomalyRad = Math.acos(cosNu);
    if (dotVec3(posECI, velECI) < 0) {
      trueAnomalyRad = 2 * Math.PI - trueAnomalyRad;
    }
  }

  // Semi-major axis a = -mu / (2 * energy)
  const isParabolic = Math.abs(specificEnergy) < 1e-3;
  const isEscape = specificEnergy >= 0 || ecc >= 1.0;
  const semiMajorAxisM = isParabolic ? null : -mu / (2 * specificEnergy);

  let periapsisAltM: number | null = null;
  let apoapsisAltM: number | null = null;
  let periodS: number | null = null;
  let timeToApoapsisS: number | null = null;
  let timeToPeriapsisS: number | null = null;
  let periapsisECI: Vec3d | null = null;
  let apoapsisECI: Vec3d | null = null;

  const pAxis = ecc > 1e-5 ? normVec3(eVec) : normVec3(posECI);

  if (!isEscape && semiMajorAxisM !== null && semiMajorAxisM > 0) {
    const rPeri = semiMajorAxisM * (1 - ecc);
    const rApo = semiMajorAxisM * (1 + ecc);
    periapsisAltM = rPeri - R;
    apoapsisAltM = rApo - R;
    periodS = 2 * Math.PI * Math.sqrt((semiMajorAxisM ** 3) / mu);

    periapsisECI = scaleVec3(pAxis, rPeri);
    apoapsisECI = scaleVec3(pAxis, -rApo);

    // Compute exact eccentric anomaly E and mean anomaly M for time to AP / PE
    const tanHalfNu = Math.tan(trueAnomalyRad * 0.5);
    const sqrtFactor = Math.sqrt(Math.max(1e-9, (1 - ecc) / (1 + ecc)));
    let E = 2 * Math.atan(sqrtFactor * tanHalfNu);
    if (E < 0) E += 2 * Math.PI;
    const M = E - ecc * Math.sin(E); // 0..2pi from periapsis

    const meanMotion = (2 * Math.PI) / periodS;
    // Time to periapsis (M = 2pi)
    const dMPe = M <= 1e-6 ? 0 : 2 * Math.PI - M;
    timeToPeriapsisS = dMPe / meanMotion;

    // Time to apoapsis (M = pi)
    const dMAp = M <= Math.PI ? Math.PI - M : 3 * Math.PI - M;
    timeToApoapsisS = dMAp / meanMotion;
  } else if (isEscape) {
    // Hyperbolic escape trajectory
    const p = (hMag * hMag) / mu;
    const rPeri = p / (1 + ecc);
    periapsisAltM = rPeri - R;
    apoapsisAltM = null;
    periodS = null;
    timeToApoapsisS = null;
    periapsisECI = scaleVec3(pAxis, rPeri);
    apoapsisECI = null;
    // Approximate time to periapsis if inbound
    if (dotVec3(posECI, velECI) < 0 && semiMajorAxisM !== null) {
      const aAbs = Math.abs(semiMajorAxisM);
      const coshH = clamp((ecc + Math.cos(trueAnomalyRad)) / (1 + ecc * Math.cos(trueAnomalyRad)), 1, 1e6);
      const H = Math.acosh(coshH);
      const Mh = ecc * Math.sinh(H) - H;
      const n = Math.sqrt(mu / (aAbs ** 3));
      timeToPeriapsisS = Mh / n;
    }
  }

  // Classify trajectory cleanly
  let classification: TrajectoryClassification;
  if (isEscape) {
    classification = 'ESCAPE';
  } else if (periapsisAltM !== null && periapsisAltM >= PLANET_CONFIG.karmanLineM) {
    classification = 'ORBITAL';
  } else if (
    altitudeASLM < PLANET_CONFIG.karmanLineM &&
    verticalVelMs < -40 &&
    vMag > 1100
  ) {
    classification = 'REENTRY';
  } else if (apoapsisAltM !== null && apoapsisAltM >= PLANET_CONFIG.karmanLineM) {
    classification = 'SUBORBITAL';
  } else {
    classification = 'ATMOSPHERIC';
  }

  return {
    valid: true,
    apoapsisAltM,
    periapsisAltM,
    semiMajorAxisM,
    eccentricity: ecc,
    inclinationDeg,
    periodS,
    timeToApoapsisS,
    timeToPeriapsisS,
    specificEnergyJkg: specificEnergy,
    trueAnomalyRad,
    posECI,
    velECI,
    inertialSpeedMs: vMag,
    hVecECI: hVec,
    eVecECI: eVec,
    apoapsisECI,
    periapsisECI,
    classification,
  };
}

function invalidElements(
  classification: TrajectoryClassification,
  posECI: Vec3d,
  velECI: Vec3d,
  inertialSpeedMs: number,
  specificEnergyJkg: number,
  hVecECI: Vec3d,
  eVecECI: Vec3d
): OrbitalElements {
  return {
    valid: false,
    apoapsisAltM: null,
    periapsisAltM: null,
    semiMajorAxisM: null,
    eccentricity: null,
    inclinationDeg: null,
    periodS: null,
    timeToApoapsisS: null,
    timeToPeriapsisS: null,
    specificEnergyJkg,
    trueAnomalyRad: 0,
    posECI,
    velECI,
    inertialSpeedMs,
    hVecECI,
    eVecECI,
    apoapsisECI: null,
    periapsisECI: null,
    classification,
  };
}

/**
 * Sample the predicted Keplerian two-body trajectory (orbit or suborbital ballistic arc)
 * plus surface ground-track and impact point for the 3D Orbital Map.
 *
 * Uses analytic conic evaluation in the orbital perifocal plane (instantaneous, zero drift,
 * handles circular, elliptical, suborbital, and hyperbolic escape trajectories).
 */
export function samplePredictedTrajectory(
  elements: OrbitalElements,
  earthRotationRad: number,
  segments = 160
): PredictedTrajectory {
  const empty: PredictedTrajectory = {
    pointsECEF: [],
    groundTrackECEF: [],
    apoapsisECEF: null,
    periapsisECEF: null,
    impactECEF: null,
    isClosedOrbit: false,
  };
  if (!elements.valid || elements.eccentricity === null) return empty;

  const mu = PLANET_CONFIG.mu;
  const R = PLANET_CONFIG.meanRadiusM;
  const hMag = lenVec3(elements.hVecECI);
  if (hMag < 1e4) return empty;

  const ecc = elements.eccentricity;
  const p = (hMag * hMag) / mu; // Semi-latus rectum

  // Orthonormal perifocal basis (P toward periapsis, W along angular momentum, Q = W x P)
  const wHat = scaleVec3(elements.hVecECI, 1 / hMag);
  const pHat = ecc > 1e-5 ? normVec3(elements.eVecECI) : normVec3(elements.posECI);
  const qHat = normVec3(crossVec3(wHat, pHat));

  const pointsECEF: Vec3d[] = [];
  const groundTrackECEF: Vec3d[] = [];
  let impactECEF: Vec3d | null = null;

  const isEscape = ecc >= 1.0 || elements.semiMajorAxisM === null || elements.semiMajorAxisM < 0;
  const isClosedOrbit = !isEscape && (elements.periapsisAltM ?? -1) > 0;

  if (isClosedOrbit) {
    // Full 360° closed orbit sampled from current true anomaly
    const period = elements.periodS ?? 5400;
    for (let i = 0; i <= segments; i++) {
      const frac = i / segments;
      const nu = elements.trueAnomalyRad + frac * Math.PI * 2;
      const r = p / Math.max(1e-6, 1 + ecc * Math.cos(nu));
      const cosNu = Math.cos(nu);
      const sinNu = Math.sin(nu);

      const ptECI: Vec3d = {
        x: r * (cosNu * pHat.x + sinNu * qHat.x),
        y: r * (cosNu * pHat.y + sinNu * qHat.y),
        z: r * (cosNu * pHat.z + sinNu * qHat.z),
      };

      // Inertial orbit displayed in current ECEF frame
      const ptECEF = eciPosToECEF(ptECI, earthRotationRad);
      pointsECEF.push(ptECEF);

      // Ground track accounts for Earth rotating eastward underneath the spacecraft over 1 orbit!
      const futureRot = earthRotationRad + PLANET_CONFIG.rotationRateRadPerSec * (frac * period);
      const gtECEF = eciPosToECEF(scaleVec3(normVec3(ptECI), R + 12_000), futureRot);
      groundTrackECEF.push(gtECEF);
    }
  } else if (!isEscape) {
    // Suborbital elliptical arc: walk forward in true anomaly until hitting Earth's surface (r <= R)
    const startNu = elements.trueAnomalyRad;
    const maxSpan = Math.PI * 2;
    const steps = segments;
    for (let i = 0; i <= steps; i++) {
      const nu = startNu + (i / steps) * maxSpan;
      const r = p / Math.max(1e-6, 1 + ecc * Math.cos(nu));
      const cosNu = Math.cos(nu);
      const sinNu = Math.sin(nu);
      const ptECI: Vec3d = {
        x: r * (cosNu * pHat.x + sinNu * qHat.x),
        y: r * (cosNu * pHat.y + sinNu * qHat.y),
        z: r * (cosNu * pHat.z + sinNu * qHat.z),
      };
      const ptECEF = eciPosToECEF(ptECI, earthRotationRad);

      if (i > 0 && r <= R) {
        const clamped = scaleVec3(normVec3(ptECEF), R);
        pointsECEF.push(clamped);
        impactECEF = clamped;
        break;
      }
      pointsECEF.push(ptECEF);
      groundTrackECEF.push(scaleVec3(normVec3(ptECEF), R + 12_000));
    }
  } else {
    // Hyperbolic escape trajectory out to 45,000 km
    const nuAsymp = Math.acos(-1 / ecc) - 0.08;
    const startNu = clamp(elements.trueAnomalyRad > Math.PI ? elements.trueAnomalyRad - 2 * Math.PI : elements.trueAnomalyRad, -nuAsymp, nuAsymp);
    for (let i = 0; i <= segments; i++) {
      const nu = startNu + (i / segments) * (nuAsymp - startNu);
      const denom = 1 + ecc * Math.cos(nu);
      if (denom <= 0.02) break;
      const r = p / denom;
      if (r > R + 45_000_000) break;
      const cosNu = Math.cos(nu);
      const sinNu = Math.sin(nu);
      const ptECI: Vec3d = {
        x: r * (cosNu * pHat.x + sinNu * qHat.x),
        y: r * (cosNu * pHat.y + sinNu * qHat.y),
        z: r * (cosNu * pHat.z + sinNu * qHat.z),
      };
      const ptECEF = eciPosToECEF(ptECI, earthRotationRad);
      pointsECEF.push(ptECEF);
    }
  }

  const apoapsisECEF =
    elements.apoapsisECI && (elements.apoapsisAltM ?? -1) > 0
      ? eciPosToECEF(elements.apoapsisECI, earthRotationRad)
      : null;
  const periapsisECEF =
    elements.periapsisECI && (elements.periapsisAltM ?? -1) > 0
      ? eciPosToECEF(elements.periapsisECI, earthRotationRad)
      : null;

  return {
    pointsECEF,
    groundTrackECEF,
    apoapsisECEF,
    periapsisECEF,
    impactECEF,
    isClosedOrbit,
  };
}

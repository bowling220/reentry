import { PLANET_CONFIG } from '../config/planetConfig';
import { Vec3d, lenSqVec3, scaleVec3 } from '../math/vec3d';

/**
 * Computes central inverse-square gravitational acceleration directed toward Earth's center (0,0,0).
 *
 * g(r) = -mu / |r|^3 * r
 *
 * Future phases can add J2 oblateness harmonics and third-body perturbations (Moon/Sun)
 * inside this module without changing callers.
 */
export function computeGravityECEF(posECEF: Vec3d): Vec3d {
  const r2 = lenSqVec3(posECEF);
  // Clamp minimum radius defensively to avoid divide-by-zero
  const safeR2 = Math.max(r2, 1_000_000);
  const r = Math.sqrt(safeR2);
  const factor = -PLANET_CONFIG.mu / (safeR2 * r);
  return scaleVec3(posECEF, factor);
}

/**
 * Scalar gravitational acceleration magnitude at a given altitude above mean sea level (m/s^2).
 */
export function computeGravityMagnitude(altitudeM: number): number {
  const r = Math.max(1000, PLANET_CONFIG.meanRadiusM + altitudeM);
  return PLANET_CONFIG.mu / (r * r);
}

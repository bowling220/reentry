import { PLANET_CONFIG } from '../config/planetConfig';
import {
  DEG2RAD,
  RAD2DEG,
  Vec3d,
  Quatd,
  addVec3,
  conjQuat,
  crossVec3,
  dotVec3,
  lenVec3,
  mulQuat,
  normVec3,
  quatFromBasis,
  rotateVecByQuat,
  subVec3,
} from './vec3d';

/**
 * Geodetic coordinates on the spherical Earth model.
 */
export interface GeodeticCoords {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeM: number;
}

/**
 * Local tangent frame (East-Up-South right-handed basis matching Three.js Y-up convention):
 *   +X = East
 *   +Y = Up (outward radial from Earth center)
 *   +Z = South (-North)
 *
 * Notice that East x Up = South, forming a strict right-handed coordinate system.
 */
export interface LocalTangentFrame {
  originECEF: Vec3d;
  east: Vec3d;
  up: Vec3d;
  south: Vec3d;
  north: Vec3d;
  /** Rotation from local frame (+X=East, +Y=Up, +Z=South) to global ECEF */
  localToECEF: Quatd;
  /** Rotation from global ECEF to local frame */
  ecefToLocal: Quatd;
}

/**
 * Convert geographic (lat, lon, alt) to Earth-Centered Earth-Fixed (ECEF) Cartesian coordinates.
 *
 * Axis convention aligned directly with Three.js SphereGeometry equirectangular mapping:
 *   +Y = North Pole (lat = +90°)
 *   +X = Prime Meridian at Equator (lat = 0°, lon = 0°)
 *   -Z = 90° East at Equator (lat = 0°, lon = +90°)
 *   +Z = 90° West at Equator (lat = 0°, lon = -90°)
 */
export function geodeticToECEF(
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeM = 0,
  planetRadiusM = PLANET_CONFIG.meanRadiusM
): Vec3d {
  const lat = latitudeDeg * DEG2RAD;
  const lon = longitudeDeg * DEG2RAD;
  const r = planetRadiusM + altitudeM;
  const cosLat = Math.cos(lat);
  return {
    x: r * cosLat * Math.cos(lon),
    y: r * Math.sin(lat),
    z: -r * cosLat * Math.sin(lon),
  };
}

/**
 * Convert ECEF position to geographic (latitudeDeg, longitudeDeg, altitudeM).
 */
export function ecefToGeodetic(
  posECEF: Vec3d,
  planetRadiusM = PLANET_CONFIG.meanRadiusM
): GeodeticCoords {
  const r = lenVec3(posECEF);
  if (r < 1e-6) {
    return { latitudeDeg: 0, longitudeDeg: 0, altitudeM: -planetRadiusM };
  }
  const latRad = Math.asin(Math.max(-1, Math.min(1, posECEF.y / r)));
  const lonRad = Math.atan2(-posECEF.z, posECEF.x);
  return {
    latitudeDeg: latRad * RAD2DEG,
    longitudeDeg: lonRad * RAD2DEG,
    altitudeM: r - planetRadiusM,
  };
}

/**
 * Build the local East-Up-South tangent frame at a given ECEF position.
 */
export function buildTangentFrameFromECEF(originECEF: Vec3d): LocalTangentFrame {
  const up = normVec3(originECEF);
  const worldNorth: Vec3d = { x: 0, y: 1, z: 0 };

  // Handle pole degeneracy gracefully
  let east: Vec3d;
  if (Math.abs(dotVec3(up, worldNorth)) > 0.99999) {
    east = { x: 1, y: 0, z: 0 };
  } else {
    // Up x North = West? Check: at lon=0, lat=0: up=(1,0,0), worldNorth=(0,1,0)
    // worldNorth x up = (0,1,0) x (1,0,0) = (0,0,-1) = East!
    east = normVec3(crossVec3(worldNorth, up));
  }
  // East x Up = South! Check: (0,0,-1) x (1,0,0) = (0,-1,0) = South!
  const south = normVec3(crossVec3(east, up));
  const north = { x: -south.x, y: -south.y, z: -south.z };

  const localToECEF = quatFromBasis(east, up, south);
  const ecefToLocal = conjQuat(localToECEF);

  return {
    originECEF,
    east,
    up,
    south,
    north,
    localToECEF,
    ecefToLocal,
  };
}

/**
 * Build a local East-Up-South tangent frame at geographic coordinates.
 */
export function buildTangentFrame(
  latitudeDeg: number,
  longitudeDeg: number,
  altitudeM = 0
): LocalTangentFrame {
  return buildTangentFrameFromECEF(geodeticToECEF(latitudeDeg, longitudeDeg, altitudeM));
}

/**
 * Transform a point from a local tangent frame to global ECEF.
 */
export function localPointToECEF(localPt: Vec3d, frame: LocalTangentFrame): Vec3d {
  return addVec3(frame.originECEF, rotateVecByQuat(localPt, frame.localToECEF));
}

/**
 * Transform a point from global ECEF into a local tangent frame.
 */
export function ecefPointToLocal(ecefPt: Vec3d, frame: LocalTangentFrame): Vec3d {
  return rotateVecByQuat(subVec3(ecefPt, frame.originECEF), frame.ecefToLocal);
}

/**
 * Transform a direction/velocity vector from local frame to ECEF.
 */
export function localVectorToECEF(localVec: Vec3d, frame: LocalTangentFrame): Vec3d {
  return rotateVecByQuat(localVec, frame.localToECEF);
}

/**
 * Transform a direction/velocity vector from ECEF to local frame.
 */
export function ecefVectorToLocal(ecefVec: Vec3d, frame: LocalTangentFrame): Vec3d {
  return rotateVecByQuat(ecefVec, frame.ecefToLocal);
}

/**
 * Transform an orientation quaternion from local frame to ECEF.
 */
export function localQuatToECEF(localQ: Quatd, frame: LocalTangentFrame): Quatd {
  return mulQuat(frame.localToECEF, localQ);
}

/**
 * Transform an orientation quaternion from ECEF to local frame.
 */
export function ecefQuatToLocal(ecefQ: Quatd, frame: LocalTangentFrame): Quatd {
  return mulQuat(frame.ecefToLocal, ecefQ);
}

/**
 * Great-circle surface distance between two ECEF points along Earth's mean sphere (m).
 */
export function surfaceDistanceM(
  aECEF: Vec3d,
  bECEF: Vec3d,
  planetRadiusM = PLANET_CONFIG.meanRadiusM
): number {
  const na = normVec3(aECEF);
  const nb = normVec3(bECEF);
  const cosAngle = Math.max(-1, Math.min(1, dotVec3(na, nb)));
  return Math.acos(cosAngle) * planetRadiusM;
}

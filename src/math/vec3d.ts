/**
 * Double-precision 3D vector and quaternion operations for planetary-scale physics.
 * JavaScript numbers are IEEE 754 float64 (~15-17 significant digits), providing
 * sub-nanometer precision even at Earth-scale distances (6.371e6 m).
 */
export interface Vec3d {
  x: number;
  y: number;
  z: number;
}

export interface Quatd {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3d {
  return { x, y, z };
}

export function cloneVec3(v: Vec3d): Vec3d {
  return { x: v.x, y: v.y, z: v.z };
}

export function addVec3(a: Vec3d, b: Vec3d): Vec3d {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subVec3(a: Vec3d, b: Vec3d): Vec3d {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scaleVec3(v: Vec3d, s: number): Vec3d {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function addScaledVec3(a: Vec3d, b: Vec3d, s: number): Vec3d {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

export function dotVec3(a: Vec3d, b: Vec3d): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function crossVec3(a: Vec3d, b: Vec3d): Vec3d {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lenSqVec3(v: Vec3d): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function lenVec3(v: Vec3d): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function normVec3(v: Vec3d): Vec3d {
  const len = lenVec3(v);
  if (len < 1e-15) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function distVec3(a: Vec3d, b: Vec3d): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function quatIdentity(): Quatd {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function cloneQuat(q: Quatd): Quatd {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

export function normQuat(q: Quatd): Quatd {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-15) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

export function conjQuat(q: Quatd): Quatd {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function mulQuat(a: Quatd, b: Quatd): Quatd {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatFromAxisAngle(axis: Vec3d, angleRad: number): Quatd {
  const half = angleRad * 0.5;
  const s = Math.sin(half);
  const n = normVec3(axis);
  return { x: n.x * s, y: n.y * s, z: n.z * s, w: Math.cos(half) };
}

export function rotateVecByQuat(v: Vec3d, q: Quatd): Vec3d {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const ix = qw * v.x + qy * v.z - qz * v.y;
  const iy = qw * v.y + qz * v.x - qx * v.z;
  const iz = qw * v.z + qx * v.y - qy * v.x;
  const iw = -qx * v.x - qy * v.y - qz * v.z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

/**
 * Construct a quaternion from three orthonormal basis columns (right = +X, up = +Y, back = +Z).
 */
export function quatFromBasis(right: Vec3d, up: Vec3d, back: Vec3d): Quatd {
  const m00 = right.x, m01 = up.x, m02 = back.x;
  const m10 = right.y, m11 = up.y, m12 = back.y;
  const m20 = right.z, m21 = up.z, m22 = back.z;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  return normQuat({ x, y, z, w });
}

/**
 * Integrate quaternion orientation using angular velocity expressed in the body's local frame.
 */
export function integrateQuatBodyRate(q: Quatd, omegaBody: Vec3d, dt: number): Quatd {
  const speed = lenVec3(omegaBody);
  if (speed < 1e-12) return q;
  const dq = quatFromAxisAngle(omegaBody, speed * dt);
  return normQuat(mulQuat(q, dq));
}

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

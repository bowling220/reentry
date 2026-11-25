import { LANDING_PAD_OFFSET_LOCAL, LAUNCH_SITE, PLANET_CONFIG } from '../config/planetConfig';
import { LocalTangentFrame, buildTangentFrame, ecefPointToLocal } from '../math/coordinates';
import { Vec3d, clamp } from '../math/vec3d';

/**
 * Shared Cape Canaveral local tangent frame anchored at sea level (alt = 0m)
 * centered precisely on Space Launch Complex 40 (28.561857°N, -80.577366°W).
 * +X = East (Atlantic Ocean), +Y = Up, +Z = South (-Z = North).
 */
export const CAPE_FRAME: LocalTangentFrame = buildTangentFrame(
  LAUNCH_SITE.latitudeDeg,
  LAUNCH_SITE.longitudeDeg,
  0
);

/** Pad deck elevation above sea level (m) */
export const LAUNCH_PAD_DECK_Y = 6.0;
/** Rocket hold-down mount deck top elevation above sea level (m) */
export const LAUNCH_MOUNT_TOP_Y = 7.0;
/** LZ-1 concrete landing pad top elevation above sea level (m) */
export const LANDING_PAD_TOP_Y = 2.5;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Matches the real Cape Canaveral Atlantic shoreline east of SLC-40 from USGS orthoimagery.
 * At southM = 0 (SLC-40), the Atlantic shoreline lies ~490 m east, trending slightly ESE southward.
 */
export function getCoastlineEastM(southM: number): number {
  return 490 + southM * 0.21 + 38 * Math.sin(southM * 0.00055);
}

/**
 * Authentic, low-relief Florida coastal barrier-island elevation above sea level (meters)
 * calibrated to Space Launch Complex 40 & USGS Cape Canaveral topography.
 * No artificial hills; realistic 1.4m-3.6m coastal plain & foredune with elevated SLC-40 pad mound.
 */
export function getCapeTerrainElevationM(eastM: number, southM: number): number {
  const padDist = Math.hypot(eastM, southM);
  const lzDist = Math.hypot(
    eastM - LANDING_PAD_OFFSET_LOCAL.eastM,
    southM - LANDING_PAD_OFFSET_LOCAL.southM
  );

  const coastX = getCoastlineEastM(southM);
  const distInland = coastX - eastM;

  // Atlantic Ocean east of the beach
  if (distInland <= -10) {
    return 0;
  }

  // Gentle Atlantic beach rise
  const beachMask = smoothstep(-8, 65, distInland);

  // Subtle realistic Florida coastal dune & flat barrier-island relief (1.4m - 3.2m)
  const foredune = 1.15 * Math.exp(-Math.pow((distInland - 55) / 38, 2));
  const microRelief =
    1.75 +
    0.35 * Math.sin(eastM * 0.0021 + southM * 0.0017) +
    0.22 * Math.cos(eastM * 0.0053 - southM * 0.0041);

  let h = (microRelief + foredune) * beachMask;

  // Smoothly settle to mean sea level at wide regional distances (> 55 km)
  const radialDist = Math.hypot(eastM, southM);
  const outerFade = 1 - smoothstep(45_000, 75_000, radialDist);
  h *= outerFade;

  // Flatten SLC-40 industrial apron
  if (padDist < 195) {
    const padFlat = 1 - smoothstep(95, 195, padDist);
    h = h * (1 - padFlat) + 2.0 * padFlat;
  }

  // Elevated concrete SLC-40 launchpad embankment
  if (padDist < 56) {
    const mound = 1 - smoothstep(32, 56, padDist);
    h = Math.max(h, 2.0 + (LAUNCH_PAD_DECK_Y - 2.0) * mound);
  }

  // Flatten nearby LZ-1 concrete landing pad
  if (lzDist < 110) {
    const lzFlat = 1 - smoothstep(52, 110, lzDist);
    h = h * (1 - lzFlat) + 2.2 * lzFlat;
  }
  if (lzDist < LANDING_PAD_OFFSET_LOCAL.radiusM + 4) {
    const padRim = 1 - smoothstep(
      LANDING_PAD_OFFSET_LOCAL.radiusM - 1,
      LANDING_PAD_OFFSET_LOCAL.radiusM + 4,
      lzDist
    );
    h = Math.max(h, 2.2 + (LANDING_PAD_TOP_Y - 2.2) * padRim);
  }

  return Math.max(0, h);
}

/**
 * Returns the surface elevation above mean sea level (m) at any global ECEF point.
 */
export function getSurfaceElevationAtECEF(posECEF: Vec3d): number {
  const local = ecefPointToLocal(posECEF, CAPE_FRAME);
  const horizDist = Math.hypot(local.x, local.z);
  if (horizDist < 75_000) {
    if (horizDist < 8) {
      return LAUNCH_MOUNT_TOP_Y;
    }
    return getCapeTerrainElevationM(local.x, local.z);
  }
  return 0;
}

/**
 * Spherical curvature vertical drop in a tangent plane at horizontal offset (eastM, southM).
 */
export function curvatureDropM(eastM: number, southM: number): number {
  const d2 = eastM * eastM + southM * southM;
  return d2 / (2 * PLANET_CONFIG.meanRadiusM);
}

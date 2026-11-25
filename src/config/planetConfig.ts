/**
 * Real-scale Earth and Cape Canaveral launch site configuration.
 * All physical values strictly use SI units (meters, kilograms, seconds, radians).
 */
export const PLANET_CONFIG = {
  name: 'Earth',
  /** Mean spherical Earth radius in meters (6,371 km) */
  meanRadiusM: 6_371_000,
  /** Earth diameter in meters (12,742 km) */
  diameterM: 12_742_000,
  /** Standard gravitational parameter GM = G * M_earth (m^3 / s^2) */
  mu: 3.986004418e14,
  /** Reference surface gravity at mean radius (m/s^2) — GM / R^2 ≈ 9.81998, nominal 9.80665 */
  surfaceGravity: 9.80665,
  /** Earth sidereal angular rotation rate (rad/s), 2*pi / 86164.0905 s */
  rotationRateRadPerSec: 7.2921159e-5,
  /** Kármán line reference altitude (m) */
  karmanLineM: 100_000,
  /** Effective upper atmosphere cutoff for aerodynamic drag (m) */
  atmosphereTopM: 160_000,
  /** Visual atmosphere outer shell radius (m) */
  atmosphereVisualHeightM: 120_000,
  /** Sea-level standard atmospheric pressure (Pa) */
  seaLevelPressurePa: 101_325,
  /** Sea-level standard air density (kg/m^3) */
  seaLevelDensityKgM3: 1.225,
  /** Initial solar hour angle at Cape Canaveral (bright morning launch lighting) */
  initialSunLocalHourDeg: -38,
  /** Solar declination (degrees, spring/early summer Florida sun) */
  sunDeclinationDeg: 18,
} as const;

export interface GeographicSite {
  name: string;
  code: string;
  latitudeDeg: number;
  longitudeDeg: number;
  elevationM: number;
}

/**
 * Cape Canaveral Space Force Station / Kennedy Space Center launch area.
 * Positioned along the real Florida Atlantic coast (~SLC-40 / LC-39A corridor).
 */
export const LAUNCH_SITE: GeographicSite = {
  name: 'Cape Canaveral Launch Complex',
  code: 'CC-LC40',
  latitudeDeg: 28.561857,
  longitudeDeg: -80.577366,
  /** Launch pad concrete deck height above local sea level (m) */
  elevationM: 5.0,
};

/**
 * Nearby booster recovery landing pad (inspired by Landing Zone 1).
 * Offset in local East-Up-South meters relative to LAUNCH_SITE.
 */
export const LANDING_PAD_OFFSET_LOCAL = {
  /** Slightly inland (west) and south along the coast from the launch pad */
  eastM: -320,
  upM: 0.2,
  southM: 520,
  radiusM: 43,
} as const;

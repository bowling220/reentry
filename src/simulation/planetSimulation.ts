import { LAUNCH_SITE, PLANET_CONFIG } from '../config/planetConfig';
import { DEG2RAD, Vec3d, normVec3 } from '../math/vec3d';

/**
 * Tracks planetary rotation, simulation clock, and solar lighting direction in ECEF.
 */
export class PlanetSimulation {
  /** Total elapsed planetary simulation time in seconds */
  public planetTimeS = 0;

  /** Accumulated sidereal rotation angle of Earth (radians) */
  public earthRotationRad = 0;

  /** Initial solar longitude in ECEF so Cape Canaveral begins in crisp morning sunlight */
  private readonly initialSunLonRad: number;
  private readonly sunDeclinationRad: number;

  constructor() {
    // Subsolar longitude offset east of Cape Canaveral so morning sun illuminates the pad & coastline
    const subsolarLonDeg = LAUNCH_SITE.longitudeDeg - PLANET_CONFIG.initialSunLocalHourDeg;
    this.initialSunLonRad = subsolarLonDeg * DEG2RAD;
    this.sunDeclinationRad = PLANET_CONFIG.sunDeclinationDeg * DEG2RAD;
  }

  public reset(): void {
    this.planetTimeS = 0;
    this.earthRotationRad = 0;
  }

  public step(dt: number): void {
    this.planetTimeS += dt;
    this.earthRotationRad += PLANET_CONFIG.rotationRateRadPerSec * dt;
  }

  /**
   * Earth angular velocity vector in ECEF (rad/s) — along +Y (North Pole).
   */
  public getAngularVelocityECEF(): Vec3d {
    return { x: 0, y: PLANET_CONFIG.rotationRateRadPerSec, z: 0 };
  }

  /**
   * Unit vector pointing from Earth toward the Sun in ECEF.
   * As Earth rotates eastward (+Y right-hand rule), the Sun moves westward in ECEF.
   */
  public getSunDirectionECEF(): Vec3d {
    const lon = this.initialSunLonRad - this.earthRotationRad;
    const dec = this.sunDeclinationRad;
    const cosDec = Math.cos(dec);
    return normVec3({
      x: cosDec * Math.cos(lon),
      y: Math.sin(dec),
      z: -cosDec * Math.sin(lon),
    });
  }
}

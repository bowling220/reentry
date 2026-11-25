import { PLANET_CONFIG } from '../config/planetConfig';

export interface AtmosphereSample {
  /** Air density (kg/m^3) */
  densityKgM3: number;
  /** Static air pressure (Pa) */
  pressurePa: number;
  /** Temperature (K) */
  temperatureK: number;
  /** Local speed of sound (m/s) */
  speedOfSoundMs: number;
  /** Normalized atmospheric pressure ratio P / P0 (0..1) */
  pressureRatio: number;
}

/**
 * Multi-layer US Standard Atmosphere (1976) approximation from sea level up to 160 km.
 * Smoothly decays to near-vacuum past the 100 km Kármán line.
 */
interface AtmoLayer {
  baseAltM: number;
  baseTempK: number;
  basePressurePa: number;
  lapseRateKPerM: number;
}

const GAS_CONSTANT_AIR = 287.05287; // J / (kg * K)
const GAMMA_AIR = 1.4;
const G0 = 9.80665;

const LAYERS: AtmoLayer[] = [
  { baseAltM: 0, baseTempK: 288.15, basePressurePa: 101325.0, lapseRateKPerM: -0.0065 },
  { baseAltM: 11000, baseTempK: 216.65, basePressurePa: 22632.06, lapseRateKPerM: 0.0 },
  { baseAltM: 20000, baseTempK: 216.65, basePressurePa: 5474.889, lapseRateKPerM: 0.001 },
  { baseAltM: 32000, baseTempK: 228.65, basePressurePa: 868.0187, lapseRateKPerM: 0.0028 },
  { baseAltM: 47000, baseTempK: 270.65, basePressurePa: 110.9063, lapseRateKPerM: 0.0 },
  { baseAltM: 51000, baseTempK: 270.65, basePressurePa: 66.93887, lapseRateKPerM: -0.0028 },
  { baseAltM: 71000, baseTempK: 214.65, basePressurePa: 3.95642, lapseRateKPerM: -0.002 },
  { baseAltM: 86000, baseTempK: 186.87, basePressurePa: 0.37338, lapseRateKPerM: 0.0 },
];

export function sampleAtmosphere(altitudeM: number): AtmosphereSample {
  if (altitudeM >= PLANET_CONFIG.atmosphereTopM) {
    return {
      densityKgM3: 0,
      pressurePa: 0,
      temperatureK: 187,
      speedOfSoundMs: 274,
      pressureRatio: 0,
    };
  }

  const h = Math.max(0, altitudeM);

  // Above 86 km, exponential mesopause/thermosphere decay to vacuum
  if (h >= 86000) {
    const scaleHeight = 5800;
    const pressurePa = 0.37338 * Math.exp(-(h - 86000) / scaleHeight);
    const temperatureK = 186.87 + (h - 86000) * 0.004;
    const densityKgM3 = pressurePa / (GAS_CONSTANT_AIR * temperatureK);
    const speedOfSoundMs = Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR * temperatureK);
    return {
      densityKgM3,
      pressurePa,
      temperatureK,
      speedOfSoundMs,
      pressureRatio: Math.min(1, pressurePa / PLANET_CONFIG.seaLevelPressurePa),
    };
  }

  let layer = LAYERS[0];
  for (let i = LAYERS.length - 1; i >= 0; i--) {
    if (h >= LAYERS[i].baseAltM) {
      layer = LAYERS[i];
      break;
    }
  }

  const dh = h - layer.baseAltM;
  let temperatureK: number;
  let pressurePa: number;

  if (Math.abs(layer.lapseRateKPerM) < 1e-9) {
    temperatureK = layer.baseTempK;
    pressurePa =
      layer.basePressurePa * Math.exp((-G0 * dh) / (GAS_CONSTANT_AIR * temperatureK));
  } else {
    temperatureK = layer.baseTempK + layer.lapseRateKPerM * dh;
    const exponent = -G0 / (GAS_CONSTANT_AIR * layer.lapseRateKPerM);
    pressurePa = layer.basePressurePa * Math.pow(temperatureK / layer.baseTempK, exponent);
  }

  const densityKgM3 = pressurePa / (GAS_CONSTANT_AIR * temperatureK);
  const speedOfSoundMs = Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR * temperatureK);

  return {
    densityKgM3,
    pressurePa,
    temperatureK,
    speedOfSoundMs,
    pressureRatio: Math.min(1, pressurePa / PLANET_CONFIG.seaLevelPressurePa),
  };
}

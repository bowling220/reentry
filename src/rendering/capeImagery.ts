import { asin, atan, clamp, float, max, min, mix, normalize, smoothstep, texture, vec2, vec3 } from 'three/tsl';
import { LoadedAssets } from '../assets/assetManager';
import { CAPE_IMAGERY_LAYERS } from '../config/capeImagery';
import { CAPE_FRAME } from '../simulation/terrainHeight';

/** Geographic coordinates from the actual curved surface, independent of camera
 * origin. Using the export's returned extent avoids stretching imagery to guessed bounds. */
export function capeSurfaceLonLat(localPosition: any): any {
  const { originECEF: o, east: e, up: u, south: s } = CAPE_FRAME;
  const point = vec3(o.x, o.y, o.z)
    .add(vec3(e.x, e.y, e.z).mul(localPosition.x))
    .add(vec3(u.x, u.y, u.z).mul(localPosition.y))
    .add(vec3(s.x, s.y, s.z).mul(localPosition.z));
  const direction = normalize(point);
  return vec2(atan(direction.z.negate(), direction.x), asin(clamp(direction.y, -1, 1))).mul(180 / Math.PI);
}

/** Nested georeferenced albedo, shared by local PBR ground and the spherical
 * planet. Missing offshore NAIP tiles become ocean rather than black rectangles. */
export function capeImageryAlbedo(base: any, assets: LoadedAssets, lonLat: any): any {
  const maps = [assets.capeSatLocal, assets.capeSatMid, assets.capeSatWide];
  let result = base;
  for (let i = CAPE_IMAGERY_LAYERS.length - 1; i >= 0; i--) {
    const map = maps[i];
    if (!map) continue;
    const [west, south, east, north] = CAPE_IMAGERY_LAYERS[i].bounds;
    const coords = lonLat.sub(vec2(west, south)).div(vec2(east - west, north - south));
    const edge = min(min(coords.x, coords.y), min(float(1).sub(coords.x), float(1).sub(coords.y)));
    const coverage = smoothstep(float(0.015), float(0.1), edge);
    const rgba = texture(map, clamp(coords, vec2(0.001), vec2(0.999)));
    const sampled = rgba.rgb;
    const valid = rgba.a.mul(smoothstep(float(0.002), float(0.018), max(max(sampled.r, sampled.g), sampled.b)));
    const ocean = vec3(0.009, 0.029, 0.052);
    // Aerial surveys end in rectangular offshore tiles. Match their blue water
    // to the surrounding ocean so survey footprints do not become a fake coast.
    const water = smoothstep(float(-0.004), float(0.012), sampled.b.sub(sampled.g))
      .mul(smoothstep(float(0.008), float(0.035), sampled.b.sub(sampled.r)));
    const surface = mix(sampled, ocean, water);
    result = mix(result, mix(ocean, surface, valid), coverage);
  }
  return result;
}

import * as THREE from 'three/webgpu';
import {
  abs,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  mix,
  normalWorld,
  normalize,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sub,
  time,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { RocketFlightDynamics } from '../simulation/flightDynamics';
import { sampleAtmosphere } from '../simulation/atmosphere';
import { Vec3d, addScaledVec3, rotateVecByQuat, subVec3 } from '../math/vec3d';
import { CAPE_FRAME, LAUNCH_PAD_DECK_Y } from '../simulation/terrainHeight';
import { localPointToECEF } from '../math/coordinates';

type ParticleKind = 'trenchSteam' | 'exhaustFire' | 'contrail' | 'shutdownSmoke' | 'crashFire';

interface PlumeParticle {
  active: boolean;
  kind: ParticleKind;
  age: number;
  life: number;
  posECEF: Vec3d;
  velECEF: Vec3d;
  size: number;
  growRate: number;
  opacity: number;
  spin: number;
}

/**
 * WebGPU-verified RP-1 / LOX & Merlin Vacuum rocket exhaust VFX system.
 *
 * Phase 3 upgrades:
 * - Curved parabolic LatheGeometry diffuse vacuum plume bell with smooth view-angle Fresnel
 *   edge feathering so high-altitude & space exhaust looks naturally gaseous and expansive
 *   rather than a rigid hard-edged cone.
 * - Automatically scales plume size to active stage thrust (9x Merlin 1D vs 1x MVac vs Sat RCS).
 */
export class ExhaustVfx {
  public readonly plumeGroup: THREE.Group;
  public readonly smokeGroup: THREE.Group;

  private readonly innerCoreMesh: THREE.Mesh;
  private readonly midFlameMesh: THREE.Mesh;
  private readonly vacuumBellMesh: THREE.Mesh;
  private readonly heatHaloMesh: THREE.Mesh;
  private readonly nozzleGlowMesh: THREE.Mesh;
  private readonly engineLight: THREE.PointLight;
  private readonly padBounceLight: THREE.PointLight;

  private readonly uThrottle = uniform(0.0);
  private readonly uPressureRatio = uniform(1.0);
  private readonly uIgnitionPulse = uniform(0.0);

  private readonly particles: PlumeParticle[] = [];
  private readonly smokeMeshes: THREE.Sprite[] = [];
  private readonly maxParticles: number;
  private trenchSpawnAcc = 0;
  private contrailSpawnAcc = 0;
  private prevThrottle = 0;
  private ignitionFlash = 0;

  constructor(enablePadSmoke = true) {
    this.plumeGroup = new THREE.Group();
    this.plumeGroup.name = 'RocketExhaustPlume';

    // 0. Bright incandescent nozzle exit glow disc
    const glowGeo = new THREE.CircleGeometry(1.65, 24);
    glowGeo.rotateX(Math.PI / 2);
    this.nozzleGlowMesh = new THREE.Mesh(glowGeo, this.createNozzleGlowMaterial());
    this.nozzleGlowMesh.position.y = -0.15;
    this.nozzleGlowMesh.frustumCulled = false;
    this.nozzleGlowMesh.renderOrder = 20;
    this.plumeGroup.add(this.nozzleGlowMesh);

    // 1. Inner supersonic core with Mach shock diamonds
    const coreGeo = new THREE.CylinderGeometry(1.1, 0.32, 22, 24, 12, true);
    coreGeo.translate(0, -11, 0);
    this.innerCoreMesh = new THREE.Mesh(coreGeo, this.createPlumeMaterial('core'));
    this.innerCoreMesh.frustumCulled = false;
    this.innerCoreMesh.renderOrder = 22;
    this.plumeGroup.add(this.innerCoreMesh);

    // 2. Mid turbulent RP-1 combustion flame column
    const midGeo = new THREE.CylinderGeometry(1.42, 1.25, 34, 28, 16, true);
    midGeo.translate(0, -17, 0);
    this.midFlameMesh = new THREE.Mesh(midGeo, this.createPlumeMaterial('mid'));
    this.midFlameMesh.frustumCulled = false;
    this.midFlameMesh.renderOrder = 21;
    this.plumeGroup.add(this.midFlameMesh);

    // 3. Curved parabolic diffuse outer plume / space vacuum jellyfish bell (LatheGeometry!)
    const bellGeo = this.createParabolicBellGeometry();
    this.vacuumBellMesh = new THREE.Mesh(bellGeo, this.createPlumeMaterial('outer'));
    this.vacuumBellMesh.frustumCulled = false;
    this.vacuumBellMesh.renderOrder = 20;
    this.plumeGroup.add(this.vacuumBellMesh);

    // 4. Soft diffuse thermal radiance / outer ionized veil
    const haloGeo = this.createParabolicBellGeometry(1.38);
    this.heatHaloMesh = new THREE.Mesh(haloGeo, this.createPlumeMaterial('halo'));
    this.heatHaloMesh.frustumCulled = false;
    this.heatHaloMesh.renderOrder = 19;
    this.plumeGroup.add(this.heatHaloMesh);

    this.engineLight = new THREE.PointLight(0xffa44c, 0, 320, 1.35);
    this.engineLight.position.set(0, -4.5, 0);
    this.plumeGroup.add(this.engineLight);

    this.padBounceLight = new THREE.PointLight(0xff7d2a, 0, 240, 1.6);
    this.padBounceLight.position.set(0, -14, 0);
    this.plumeGroup.add(this.padBounceLight);

    this.smokeGroup = new THREE.Group();
    this.smokeGroup.name = 'LaunchSmokeAndSteam';
    this.maxParticles = enablePadSmoke ? 150 : 28;
    const cloudTex = this.createTurbulentCloudSprite();

    for (let i = 0; i < this.maxParticles; i++) {
      this.particles.push({
        active: false,
        kind: 'trenchSteam',
        age: 0,
        life: 1,
        posECEF: { x: 0, y: 0, z: 0 },
        velECEF: { x: 0, y: 0, z: 0 },
        size: 10,
        growRate: 8,
        opacity: 0,
        spin: 0,
      });

      const spriteMat = new THREE.SpriteMaterial({
        map: cloudTex,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.visible = false;
      sprite.frustumCulled = false;
      sprite.renderOrder = 25;
      this.smokeMeshes.push(sprite);
      this.smokeGroup.add(sprite);
    }
  }

  /**
   * Generates an organic curved parabolic plume envelope (starts tight at nozzle, flares
   * smoothly outward like a real supersonic/vacuum Prandtl-Meyer expansion fan).
   */
  private createParabolicBellGeometry(widthMult = 1.0): THREE.LatheGeometry {
    const pts: THREE.Vector2[] = [];
    const steps = 18;
    const length = 46;
    for (let i = 0; i <= steps; i++) {
      // i = 0 at far tail (v=0), i = steps at nozzle exit (v=1) to match CylinderGeometry UV convention
      const along = 1 - i / steps; // 0 at nozzle -> 1 at tail
      const y = -along * length;
      const radius = (1.35 + Math.pow(along, 0.62) * 3.8) * widthMult;
      pts.push(new THREE.Vector2(radius, y));
    }
    return new THREE.LatheGeometry(pts, 32);
  }

  private createNozzleGlowMaterial(): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.blending = THREE.AdditiveBlending;

    const coords = uv();
    const dx = coords.x.sub(0.5).mul(2.0);
    const dy = coords.y.sub(0.5).mul(2.0);
    const r2 = dx.mul(dx).add(dy.mul(dy));
    const radial = pow(clamp(float(1.0).sub(r2), float(0.001), float(1.0)), float(1.6));

    mat.colorNode = vec3(1.0, 0.94, 0.78).mul(3.0);
    mat.opacityNode = radial.mul(this.uThrottle);
    return mat;
  }

  private createPlumeMaterial(
    layer: 'core' | 'mid' | 'outer' | 'halo'
  ): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.blending = THREE.AdditiveBlending;

    const coords = uv();
    const along = clamp(float(1.0).sub(coords.y), float(0.001), float(0.999));
    const angleU = coords.x.mul(6.2831853);
    const t = time.mul(layer === 'halo' ? 20.0 : 40.0);

    // Pure fragment-stage view-angle Fresnel edge softening eliminates rigid cone silhouettes!
    const nWorld = normalize(normalWorld);
    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const facing = clamp(abs(dot(nWorld, viewDir)), float(0.001), float(1.0));
    const edgeExp = layer === 'core' ? 0.85 : layer === 'mid' ? 1.45 : layer === 'outer' ? 2.15 : 2.6;
    const softEdge = pow(facing, float(edgeExp));

    // Supersonic flowing plasma turbulence
    const s1 = sin(along.mul(22.0).sub(t).add(sin(angleU.mul(3.0)).mul(1.8))).mul(0.5).add(0.5);
    const s2 = cos(along.mul(46.0).sub(t.mul(1.75)).sub(cos(angleU.mul(5.0)).mul(1.4))).mul(0.5).add(0.5);
    const s3 = sin(angleU.mul(7.0).add(along.mul(14.0)).sub(t.mul(0.9))).mul(0.5).add(0.5);
    const turbulence = s1.mul(0.5).add(s2.mul(0.32)).add(s3.mul(0.18));

    // Sea-level Mach shock diamonds
    const diamondWave = pow(
      clamp(sin(along.mul(36.0).sub(t.mul(0.18))).mul(0.5).add(0.5), float(0.001), float(1.0)),
      float(4.0)
    );
    const machBoost = diamondWave
      .mul(smoothstep(float(0.03), float(0.14), along))
      .mul(float(1.0).sub(smoothstep(float(0.25), float(0.8), along)))
      .mul(this.uPressureRatio);

    const entry = smoothstep(float(0.0), float(0.055), along);
    // In vacuum, exhaust diffuses smoothly & rapidly with distance from nozzle
    const tailExp = layer === 'core' ? 1.65 : layer === 'mid' ? 1.75 : layer === 'outer' ? 1.85 : 2.1;
    const tailFade = pow(clamp(float(1.0).sub(along), float(0.001), float(1.0)), float(tailExp));

    const slColor =
      layer === 'core'
        ? mix(vec3(1.0, 0.98, 0.9), vec3(1.0, 0.72, 0.3), pow(along, float(0.75)))
        : layer === 'mid'
          ? mix(vec3(1.0, 0.78, 0.32), vec3(0.98, 0.38, 0.08), pow(along, float(0.7)))
          : layer === 'outer'
            ? mix(vec3(0.98, 0.54, 0.16), vec3(0.82, 0.2, 0.04), along)
            : mix(vec3(1.0, 0.48, 0.14), vec3(0.55, 0.14, 0.03), along);

    // Diffuse realistic space vacuum plume: warm incandescent near nozzle -> gaseous lavender-cyan edge
    const vacColor =
      layer === 'core'
        ? mix(vec3(1.0, 0.95, 0.92), vec3(0.75, 0.72, 1.0), pow(along, float(0.6)))
        : layer === 'mid'
          ? mix(vec3(0.98, 0.82, 0.78), vec3(0.45, 0.56, 1.0), pow(along, float(0.65)))
          : layer === 'outer'
            ? mix(vec3(0.82, 0.62, 0.95), vec3(0.22, 0.46, 0.95), along)
            : mix(vec3(0.36, 0.52, 0.96), vec3(0.12, 0.22, 0.68), along);

    const atmoBlend = clamp(this.uPressureRatio.mul(3.4), float(0.0), float(1.0));
    const baseColor = mix(vacColor, slColor, atmoBlend);

    // Slightly lower opacity in vacuum so plume looks genuinely wispy & diffuse rather than solid!
    const vacDiffuseness = mix(float(0.62), float(1.0), atmoBlend);

    const pulse = float(1.0).add(this.uIgnitionPulse.mul(0.85));
    const gain =
      layer === 'core'
        ? float(2.5).add(machBoost.mul(2.1))
        : layer === 'mid'
          ? float(1.45).add(turbulence.mul(0.8))
          : layer === 'outer'
            ? float(0.95).add(turbulence.mul(0.6))
            : float(0.35).add(turbulence.mul(0.25));

    const alphaScale =
      layer === 'core' ? 0.94 : layer === 'mid' ? 0.62 : layer === 'outer' ? 0.42 : 0.2;

    const alpha = entry
      .mul(tailFade)
      .mul(softEdge)
      .mul(float(0.55).add(turbulence.mul(0.45)))
      .mul(this.uThrottle)
      .mul(pulse)
      .mul(alphaScale)
      .mul(vacDiffuseness);

    mat.colorNode = baseColor.mul(gain).mul(pulse);
    mat.opacityNode = clamp(alpha, float(0.0), float(1.0));
    return mat;
  }

  private createTurbulentCloudSprite(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);

    let seed = 13579;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let i = 0; i < 16; i++) {
      const a = rand() * Math.PI * 2;
      const dist = rand() * 40;
      const cx = size / 2 + Math.cos(a) * dist;
      const cy = size / 2 + Math.sin(a) * dist;
      const r = 38 + rand() * 44;
      const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, r);
      grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.36)');
      grad.addColorStop(0.5, 'rgba(242, 245, 248, 0.16)');
      grad.addColorStop(1.0, 'rgba(232, 238, 244, 0.0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  public reset(): void {
    for (let i = 0; i < this.maxParticles; i++) {
      this.particles[i].active = false;
      this.smokeMeshes[i].visible = false;
    }
    this.uThrottle.value = 0;
    this.uIgnitionPulse.value = 0;
    this.engineLight.intensity = 0;
    this.padBounceLight.intensity = 0;
    this.prevThrottle = 0;
    this.ignitionFlash = 0;
  }

  public update(rocket: RocketFlightDynamics, cameraPosECEF: Vec3d, dt: number): void {
    const thr = rocket.actualThrottle;
    const altASL = rocket.getAltitudeASL();
    const altAGL = rocket.getAltitudeAGL();
    const atmo = sampleAtmosphere(Math.max(0, altASL));
    const pRatio = atmo.pressureRatio;

    // Scale plume size proportionally to active engine thrust class (S1 8 MN vs S2 981 kN vs Sat 1.2 kN)
    const thrustScale = Math.pow(Math.max(0.002, rocket.config.maxThrustVacN / 8_227_000), 0.34);

    if (thr > 0.05 && this.prevThrottle <= 0.05) {
      this.ignitionFlash = 1.0;
    }
    if (thr < 0.04 && this.prevThrottle >= 0.15 && thrustScale > 0.2) {
      const nozzleECEF = rocket.getBasePositionECEF();
      const rocketDown = rotateVecByQuat({ x: 0, y: -1, z: 0 }, rocket.quatECEF);
      for (let k = 0; k < 8; k++) {
        this.spawnParticle('shutdownSmoke', nozzleECEF, rocketDown, altAGL, rocket.velECEF);
      }
    }
    this.prevThrottle = thr;
    this.ignitionFlash = Math.max(0, this.ignitionFlash - dt * 1.8);

    this.uThrottle.value = thr;
    this.uPressureRatio.value = pRatio;
    this.uIgnitionPulse.value = this.ignitionFlash;

    const visible = thr > 0.008 && rocket.config.maxThrustVacN > 0;
    this.plumeGroup.visible = visible;

    if (visible) {
      this.plumeGroup.rotation.set(rocket.gimbalPitchRad * 1.4, 0, -rocket.gimbalYawRad * 1.4);

      const jitter = 0.96 + 0.08 * Math.sin(performance.now() * 0.065);
      const vacRadiusScale = 1 + Math.pow(1 - pRatio, 1.15) * 4.8;
      const lenScale = (0.4 + thr * 1.1 + (1 - pRatio) * 1.25) * jitter * thrustScale;

      this.nozzleGlowMesh.scale.setScalar(thrustScale);
      this.innerCoreMesh.scale.set(
        (0.75 + thr * 0.4) * jitter * thrustScale,
        (0.35 + thr * 0.95) * jitter * thrustScale,
        (0.75 + thr * 0.4) * jitter * thrustScale
      );
      this.midFlameMesh.scale.set(
        (0.8 + thr * 0.35) * (1 + (1 - pRatio) * 2.0) * thrustScale,
        lenScale,
        (0.8 + thr * 0.35) * (1 + (1 - pRatio) * 2.0) * thrustScale
      );
      this.vacuumBellMesh.scale.set(
        (0.65 + thr * 0.35) * vacRadiusScale * thrustScale,
        lenScale * 1.15,
        (0.65 + thr * 0.35) * vacRadiusScale * thrustScale
      );
      this.heatHaloMesh.scale.set(
        (0.75 + thr * 0.4) * vacRadiusScale * thrustScale,
        lenScale * 1.05,
        (0.75 + thr * 0.4) * vacRadiusScale * thrustScale
      );

      const flicker = 0.88 + 0.24 * Math.sin(performance.now() * 0.047) * Math.cos(performance.now() * 0.023);
      this.engineLight.intensity =
        thr * (2500 + this.ignitionFlash * 1700) * flicker * (0.45 + 0.55 * pRatio) * thrustScale;

      const groundProx = Math.max(0, 1 - altAGL / 95);
      this.padBounceLight.intensity = thr * groundProx * 2300 * flicker * thrustScale;
    } else {
      this.engineLight.intensity = 0;
      this.padBounceLight.intensity = 0;
    }

    const nozzleECEF = rocket.getBasePositionECEF();
    const rocketDown = rotateVecByQuat({ x: 0, y: -1, z: 0 }, rocket.quatECEF);

    if (visible && altAGL < 140 && thrustScale > 0.3) {
      const groundFactor = Math.pow(1 - altAGL / 140, 0.9);
      this.trenchSpawnAcc += dt * (58 + this.ignitionFlash * 35) * thr * groundFactor;
      while (this.trenchSpawnAcc >= 1) {
        this.trenchSpawnAcc -= 1;
        const isFireCore = Math.random() < 0.3 && altAGL < 45;
        this.spawnParticle(
          isFireCore ? 'exhaustFire' : 'trenchSteam',
          nozzleECEF,
          rocketDown,
          altAGL,
          rocket.velECEF
        );
      }
    }

    if (visible && altAGL > 22 && altASL < 24_000 && thrustScale > 0.3) {
      const atmoTrailFactor = Math.max(0.18, pRatio);
      this.contrailSpawnAcc += dt * 22 * thr * atmoTrailFactor;
      while (this.contrailSpawnAcc >= 1) {
        this.contrailSpawnAcc -= 1;
        this.spawnParticle('contrail', nozzleECEF, rocketDown, altAGL, rocket.velECEF);
      }
    }

    if (rocket.crashFlashTimer > 1.4) {
      for (let k = 0; k < 2; k++) {
        this.spawnParticle('crashFire', nozzleECEF, { x: 0, y: 1, z: 0 }, 0, { x: 0, y: 0, z: 0 });
      }
    }

    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      const sprite = this.smokeMeshes[i];
      if (!p.active) {
        sprite.visible = false;
        continue;
      }

      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        sprite.visible = false;
        continue;
      }

      p.posECEF = addScaledVec3(p.posECEF, p.velECEF, dt);

      const dragRate = p.kind === 'contrail' ? 2.1 : 1.25;
      const drag = Math.max(0, 1 - dragRate * dt);
      p.velECEF.x *= drag;
      p.velECEF.y *= drag;
      p.velECEF.z *= drag;

      if (p.kind === 'trenchSteam' || p.kind === 'crashFire') {
        const rise = (p.kind === 'crashFire' ? 9.5 : 3.2) * dt;
        p.velECEF.x += CAPE_FRAME.up.x * rise;
        p.velECEF.y += CAPE_FRAME.up.y * rise;
        p.velECEF.z += CAPE_FRAME.up.z * rise;
      }

      p.size += p.growRate * dt;

      const lifeT = p.age / p.life;
      const fadeIn = Math.min(1, lifeT * 6.0);
      const fadeOut = Math.pow(1 - lifeT, 1.4);
      const alpha = p.opacity * fadeIn * fadeOut;

      const rel = subVec3(p.posECEF, cameraPosECEF);
      sprite.position.set(rel.x, rel.y, rel.z);
      sprite.scale.set(p.size, p.size, 1);
      sprite.visible = alpha > 0.008;

      const mat = sprite.material as THREE.SpriteMaterial;
      mat.opacity = alpha;
      mat.rotation += p.spin * dt;

      if (p.kind === 'exhaustFire') {
        mat.color.setHex(lifeT < 0.42 ? 0xffae52 : 0xf6e6d4);
      } else if (p.kind === 'trenchSteam') {
        const litWarm = visible && altAGL < 55 && lifeT < 0.35;
        mat.color.setHex(litWarm ? 0xffdfb8 : 0xf0f4f8);
      } else if (p.kind === 'contrail') {
        mat.color.setHex(0xe8ecf2);
      } else if (p.kind === 'shutdownSmoke') {
        mat.color.setHex(0x6c7076);
      } else {
        mat.color.setHex(lifeT < 0.3 ? 0xff7b28 : 0x2f3236);
      }
    }
  }

  private spawnParticle(
    kind: ParticleKind,
    nozzleECEF: Vec3d,
    exhaustDirECEF: Vec3d,
    altAGL: number,
    rocketVelECEF: Vec3d
  ): void {
    const slot = this.particles.find((p) => !p.active);
    if (!slot) return;

    slot.active = true;
    slot.kind = kind;
    slot.age = 0;
    slot.spin = (Math.random() - 0.5) * 0.9;

    if (kind === 'trenchSteam' || kind === 'exhaustFire') {
      const inTrench = altAGL < 45 && Math.random() < 0.78;
      const side = Math.random() < 0.5 ? 1 : -1;
      const angle = Math.random() * Math.PI * 2;
      const speed = kind === 'exhaustFire' ? 38 + Math.random() * 28 : 28 + Math.random() * 38;

      const vxLocal = inTrench ? (Math.random() - 0.5) * 14 : Math.cos(angle) * speed;
      const vzLocal = inTrench ? side * speed * 1.55 : Math.sin(angle) * speed;
      const vyLocal = inTrench ? 1.8 + Math.random() * 7.5 : 3.5 + Math.random() * 10;

      slot.velECEF = {
        x: CAPE_FRAME.east.x * vxLocal + CAPE_FRAME.up.x * vyLocal + CAPE_FRAME.south.x * vzLocal,
        y: CAPE_FRAME.east.y * vxLocal + CAPE_FRAME.up.y * vyLocal + CAPE_FRAME.south.y * vzLocal,
        z: CAPE_FRAME.east.z * vxLocal + CAPE_FRAME.up.z * vyLocal + CAPE_FRAME.south.z * vzLocal,
      };

      slot.posECEF =
        altAGL < 30
          ? localPointToECEF(
              {
                x: (Math.random() - 0.5) * 4.5,
                y: LAUNCH_PAD_DECK_Y + 0.9,
                z: inTrench ? side * (6 + Math.random() * 16) : (Math.random() - 0.5) * 8,
              },
              CAPE_FRAME
            )
          : addScaledVec3(nozzleECEF, exhaustDirECEF, Math.min(altAGL, 26));

      slot.life = kind === 'exhaustFire' ? 1.5 + Math.random() * 1.1 : 2.8 + Math.random() * 2.2;
      slot.size = kind === 'exhaustFire' ? 8 + Math.random() * 6 : 10 + Math.random() * 8;
      slot.growRate = kind === 'exhaustFire' ? 11 : 13 + Math.random() * 9;
      slot.opacity = kind === 'exhaustFire' ? 0.62 : 0.46;
    } else if (kind === 'contrail') {
      const jitter = 6;
      slot.posECEF = addScaledVec3(nozzleECEF, exhaustDirECEF, 26 + Math.random() * 10);
      slot.velECEF = {
        x: rocketVelECEF.x * 0.1 + exhaustDirECEF.x * 24 + (Math.random() - 0.5) * jitter,
        y: rocketVelECEF.y * 0.1 + exhaustDirECEF.y * 24 + (Math.random() - 0.5) * jitter,
        z: rocketVelECEF.z * 0.1 + exhaustDirECEF.z * 24 + (Math.random() - 0.5) * jitter,
      };
      slot.life = 2.4 + Math.random() * 1.6;
      slot.size = 6.5 + Math.random() * 4.5;
      slot.growRate = 9.5 + Math.random() * 6;
      slot.opacity = 0.28;
    } else if (kind === 'shutdownSmoke') {
      slot.posECEF = addScaledVec3(nozzleECEF, exhaustDirECEF, 3 + Math.random() * 5);
      slot.velECEF = {
        x: rocketVelECEF.x * 0.6 + exhaustDirECEF.x * 16 + (Math.random() - 0.5) * 6,
        y: rocketVelECEF.y * 0.6 + exhaustDirECEF.y * 16 + (Math.random() - 0.5) * 6,
        z: rocketVelECEF.z * 0.6 + exhaustDirECEF.z * 16 + (Math.random() - 0.5) * 6,
      };
      slot.life = 1.6 + Math.random() * 1.0;
      slot.size = 5 + Math.random() * 4;
      slot.growRate = 7;
      slot.opacity = 0.42;
    } else {
      const a = Math.random() * Math.PI * 2;
      const spd = 16 + Math.random() * 32;
      const vx = Math.cos(a) * spd;
      const vz = Math.sin(a) * spd;
      const vy = 12 + Math.random() * 26;
      slot.posECEF = { ...nozzleECEF };
      slot.velECEF = {
        x: CAPE_FRAME.east.x * vx + CAPE_FRAME.up.x * vy + CAPE_FRAME.south.x * vz,
        y: CAPE_FRAME.east.y * vx + CAPE_FRAME.up.y * vy + CAPE_FRAME.south.y * vz,
        z: CAPE_FRAME.east.z * vx + CAPE_FRAME.up.z * vy + CAPE_FRAME.south.z * vz,
      };
      slot.life = 2.8 + Math.random() * 2.2;
      slot.size = 16 + Math.random() * 14;
      slot.growRate = 18;
      slot.opacity = 0.82;
    }
  }
}

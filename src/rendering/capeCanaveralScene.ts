import * as THREE from 'three/webgpu';
import { LANDING_PAD_OFFSET_LOCAL } from '../config/planetConfig';
import { LoadedAssets } from '../assets/assetManager';
import { Vec3d, subVec3 } from '../math/vec3d';
import {
  CAPE_FRAME,
  LANDING_PAD_TOP_Y,
  LAUNCH_MOUNT_TOP_Y,
  LAUNCH_PAD_DECK_Y,
  curvatureDropM,
  getCapeTerrainElevationM,
  getCoastlineEastM,
} from '../simulation/terrainHeight';
import { CapeTerrainOcean } from './capeTerrainOcean';
import { FacilityTextures, createFacilityTextures } from './pbrTextures';

/**
 * Overhauled Cape Canaveral Space Launch Complex 40 (SLC-40) environment:
 * - Real-world USGS 3-tier satellite orthoimagery + non-repetitive TSL Atlantic Ocean
 * - Textured weathered & scorched concrete pad deck, flame trench, steel deflector wedge & deluge manifold
 * - Detailed open-truss SLC-40 Transporter-Erector (Strongback) with hydraulic rams & umbilical hoses
 * - Open-lattice SLC-40 Service/Crew Tower with X-bracing, elevator shaft, Crew Access Arm & strobes
 * - Four tapered open-lattice perimeter lightning protection towers
 * - Detailed LOX/RP-1/LN2 cryogenic tank farm, vaporizers, pipe racks & containment berms
 * - Corrugated-steel Horizontal Integration Facility (HIF), support bunker, parking & access roads
 * - Weathered/scorched LZ-1 concrete recovery pad with painted target markings
 * - Realistic multi-frond Florida coastal Sabal palms & scrub vegetation
 */
export class CapeCanaveralScene {
  public readonly group: THREE.Group;
  private readonly terrainOcean: CapeTerrainOcean;
  private readonly localStructuresGroup: THREE.Group;
  private readonly beaconMat: THREE.MeshBasicMaterial;
  private readonly textures: FacilityTextures;
  private readonly cryoVentPuffs: { mesh: THREE.Mesh; basePos: THREE.Vector3; phase: number; speed: number }[] = [];
  private beaconClock = 0;

  constructor(assets: LoadedAssets) {
    this.group = new THREE.Group();
    this.group.name = 'CapeCanaveralFacility';

    this.group.quaternion.set(
      CAPE_FRAME.localToECEF.x,
      CAPE_FRAME.localToECEF.y,
      CAPE_FRAME.localToECEF.z,
      CAPE_FRAME.localToECEF.w
    );

    // 1. Fully procedural PBR Cape Canaveral terrain & realistic Atlantic surf ocean
    this.terrainOcean = new CapeTerrainOcean(assets);
    this.group.add(this.terrainOcean.group);

    // 2. Detailed SLC-40 Launch Complex & LZ-1 structures
    this.textures = createFacilityTextures();
    this.localStructuresGroup = new THREE.Group();
    this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2b1f });

    this.buildLaunchPadAndFlameTrench(this.localStructuresGroup);
    this.buildLaunchTower(this.localStructuresGroup);
    this.buildStrongback(this.localStructuresGroup);
    this.buildLatticeLightningTowers(this.localStructuresGroup);
    this.buildPropellantTankFarm(this.localStructuresGroup);
    this.buildIndustrialFacilities(this.localStructuresGroup);
    this.buildPadMicroDetails(this.localStructuresGroup);
    this.buildRoadsAndParking(this.localStructuresGroup);
    this.buildLandingPadLZ1(this.localStructuresGroup);
    this.buildFloridaCoastalVegetation(this.localStructuresGroup);
    this.buildCryoVentVapor(this.localStructuresGroup);

    this.group.add(this.localStructuresGroup);
  }

  private buildLaunchPadAndFlameTrench(parent: THREE.Group): void {
    const padConcreteTex = this.textures.concreteAlbedo.clone();
    padConcreteTex.repeat.set(8, 8);
    padConcreteTex.needsUpdate = true;

    const padBumpTex = this.textures.concreteBump.clone();
    padBumpTex.repeat.set(8, 8);
    padBumpTex.needsUpdate = true;

    const concreteMat = new THREE.MeshStandardMaterial({
      map: padConcreteTex,
      bumpMap: padBumpTex,
      bumpScale: 0.14,
      roughness: 0.88,
      metalness: 0.05,
    });

    const scorchedTex = this.textures.scorchedConcrete.clone();
    scorchedTex.repeat.set(2, 6);
    scorchedTex.needsUpdate = true;
    const scorchedMat = new THREE.MeshStandardMaterial({
      map: scorchedTex,
      bumpMap: padBumpTex,
      bumpScale: 0.18,
      roughness: 0.94,
      metalness: 0.08,
    });

    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x4b5159,
      roughness: 0.45,
      metalness: 0.78,
    });

    const hazardTex = this.textures.hazardStripe.clone();
    hazardTex.repeat.set(6, 1);
    hazardTex.needsUpdate = true;
    const hazardMat = new THREE.MeshStandardMaterial({
      map: hazardTex,
      roughness: 0.65,
      metalness: 0.15,
    });

    const pipeMat = new THREE.MeshStandardMaterial({
      color: 0xd0d6dc,
      roughness: 0.36,
      metalness: 0.55,
    });

    // Main sloped concrete launch apron (octagonal SLC-40 embankment, top = LAUNCH_PAD_DECK_Y = 6.0m)
    const padDeck = new THREE.Mesh(
      new THREE.CylinderGeometry(33, 45, LAUNCH_PAD_DECK_Y, 8),
      concreteMat
    );
    padDeck.position.set(0, LAUNCH_PAD_DECK_Y * 0.5, 0);
    padDeck.receiveShadow = true;
    padDeck.castShadow = true;
    parent.add(padDeck);

    // Concrete perimeter curb around upper launch deck
    const curb = new THREE.Mesh(
      new THREE.CylinderGeometry(33.4, 33.8, 0.55, 8, 1, true),
      hazardMat
    );
    curb.position.set(0, LAUNCH_PAD_DECK_Y + 0.15, 0);
    parent.add(curb);

    // Recessed scorched flame trench floor running North-South under the launch mount
    const trenchFloor = new THREE.Mesh(new THREE.BoxGeometry(11.5, 0.55, 64), scorchedMat);
    trenchFloor.position.set(0, LAUNCH_PAD_DECK_Y + 0.05, 0);
    trenchFloor.receiveShadow = true;
    parent.add(trenchFloor);

    // Heavy reinforced concrete blast deflector walls flanking the flame trench
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.7, 30), concreteMat);
      wall.position.set(side * 6.9, LAUNCH_PAD_DECK_Y + 1.35, 0);
      wall.castShadow = true;
      wall.receiveShadow = true;
      parent.add(wall);

      // Sloped concrete wing buttresses outside blast walls
      for (const zOff of [-10, 0, 10]) {
        const buttress = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.1, 1.1), concreteMat);
        buttress.position.set(side * 8.6, LAUNCH_PAD_DECK_Y + 1.0, zOff);
        buttress.rotation.z = side * 0.38;
        buttress.castShadow = true;
        parent.add(buttress);
      }

      // White deluge water manifold pipes running along the flame trench rim
      const delugePipe = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 24, 12), pipeMat);
      delugePipe.rotation.x = Math.PI / 2;
      delugePipe.position.set(side * 5.2, LAUNCH_PAD_DECK_Y + 1.9, 0);
      parent.add(delugePipe);
    }

    // Steel water-cooled flame deflector wedge right beneath engine bells
    const deflector = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 4.2, 3.6, 4), steelMat);
    deflector.rotation.y = Math.PI / 4;
    deflector.scale.set(1.0, 0.45, 2.2);
    deflector.position.set(0, LAUNCH_PAD_DECK_Y + 0.5, 0);
    parent.add(deflector);

    // Heavy steel Launch Mount table (top = LAUNCH_MOUNT_TOP_Y = 7.0m)
    const mountOuter = new THREE.Mesh(
      new THREE.CylinderGeometry(6.6, 7.6, LAUNCH_MOUNT_TOP_Y - LAUNCH_PAD_DECK_Y + 0.45, 24),
      steelMat
    );
    mountOuter.position.set(0, LAUNCH_PAD_DECK_Y + 0.3, 0);
    mountOuter.castShadow = true;
    mountOuter.receiveShadow = true;
    parent.add(mountOuter);

    // Dark recessed exhaust aperture beneath the 9 Merlin engines
    const aperture = new THREE.Mesh(
      new THREE.CylinderGeometry(3.2, 3.2, 0.35, 24),
      new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.92, metalness: 0.3 })
    );
    aperture.position.set(0, LAUNCH_MOUNT_TOP_Y - 0.12, 0);
    parent.add(aperture);

    // Four articulated hydraulic hold-down clamps around the booster skirt
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      const clampGroup = new THREE.Group();
      clampGroup.position.set(Math.cos(a) * 2.55, LAUNCH_MOUNT_TOP_Y, Math.sin(a) * 2.55);
      clampGroup.rotation.y = -a;

      const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.3, 1.2), steelMat);
      base.position.y = 0.65;
      base.castShadow = true;
      clampGroup.add(base);

      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.5, 0.55), hazardMat);
      arm.position.set(-0.35, 1.45, 0);
      arm.rotation.z = 0.25;
      clampGroup.add(arm);

      parent.add(clampGroup);
    }

    // Concrete rollout ramp extending south-southwest toward the real SLC-40 HIF hangar
    const ramp = new THREE.Mesh(new THREE.BoxGeometry(15, 3.8, 44), concreteMat);
    ramp.position.set(-8, 3.0, 48);
    ramp.rotation.y = -0.22;
    ramp.rotation.x = 0.095;
    ramp.receiveShadow = true;
    parent.add(ramp);
  }

  private buildLaunchTower(parent: THREE.Group): void {
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x5c646d,
      roughness: 0.46,
      metalness: 0.72,
    });
    const darkGrateMat = new THREE.MeshStandardMaterial({
      color: 0x2c3138,
      roughness: 0.62,
      metalness: 0.74,
    });
    const claddingMat = new THREE.MeshStandardMaterial({
      map: this.textures.corrugatedAlbedo,
      bumpMap: this.textures.corrugatedBump,
      bumpScale: 0.08,
      roughness: 0.52,
      metalness: 0.42,
    });
    const whiteArmMat = new THREE.MeshStandardMaterial({
      color: 0xe2e6eb,
      roughness: 0.38,
      metalness: 0.24,
    });

    // Positioned at (-18.5, LAUNCH_PAD_DECK_Y, -6.0) matching Rapier static tower collider
    const tower = new THREE.Group();
    tower.position.set(-18.5, LAUNCH_PAD_DECK_Y, -6.0);

    const towerH = 78;
    const halfW = 3.9;
    const levels = 11;
    const bayH = towerH / levels;

    // 4 main heavy structural H-beam columns
    const colGeo = new THREE.BoxGeometry(0.68, towerH, 0.68);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const col = new THREE.Mesh(colGeo, steelMat);
        col.position.set(sx * halfW, towerH * 0.5, sz * halfW);
        col.castShadow = true;
        col.receiveShadow = true;
        tower.add(col);
      }
    }

    // Corrugated steel elevator core off-center inside lattice
    const elevator = new THREE.Mesh(new THREE.BoxGeometry(2.6, towerH - 2, 2.8), claddingMat);
    elevator.position.set(-0.9, (towerH - 2) * 0.5, -0.6);
    elevator.castShadow = true;
    elevator.receiveShadow = true;
    tower.add(elevator);

    // Open steel lattice horizontal beams, grated platforms & diagonal X-bracing per bay
    const beamXGeo = new THREE.BoxGeometry(halfW * 2, 0.34, 0.34);
    const beamZGeo = new THREE.BoxGeometry(0.34, 0.34, halfW * 2);
    const diagLen = Math.hypot(halfW * 2, bayH);
    const diagGeo = new THREE.BoxGeometry(diagLen, 0.22, 0.22);
    const diagAngle = Math.atan2(bayH, halfW * 2);

    for (let i = 0; i < levels; i++) {
      const yBottom = i * bayH;
      const yMid = yBottom + bayH * 0.5;
      const yTop = yBottom + bayH;

      // Perimeter beams at top of each bay
      for (const s of [-1, 1]) {
        const bx = new THREE.Mesh(beamXGeo, steelMat);
        bx.position.set(0, yTop, s * halfW);
        tower.add(bx);

        const bz = new THREE.Mesh(beamZGeo, steelMat);
        bz.position.set(s * halfW, yTop, 0);
        tower.add(bz);

        // Alternating diagonal structural truss braces on front & back faces
        const braceF = new THREE.Mesh(diagGeo, steelMat);
        braceF.position.set(0, yMid, s * halfW);
        braceF.rotation.z = (i % 2 === 0 ? 1 : -1) * diagAngle;
        tower.add(braceF);

        const braceS = new THREE.Mesh(diagGeo, steelMat);
        braceS.position.set(s * halfW, yMid, 0);
        braceS.rotation.y = Math.PI / 2;
        braceS.rotation.z = (i % 2 === 0 ? -1 : 1) * diagAngle;
        tower.add(braceS);
      }

      // Service deck floor grate every 2nd bay
      if (i % 2 === 1 || i === levels - 1) {
        const deck = new THREE.Mesh(
          new THREE.BoxGeometry(halfW * 2 + 0.5, 0.28, halfW * 2 + 0.5),
          darkGrateMat
        );
        deck.position.set(0, yTop, 0);
        deck.castShadow = true;
        tower.add(deck);
      }
    }

    // Modern SLC-40 White Crew Access Arm (CAA) rotated cleanly away from flight corridor
    const caaGroup = new THREE.Group();
    caaGroup.position.set(halfW, 56.5, 1.5);
    caaGroup.rotation.y = -0.34;

    const caaBody = new THREE.Mesh(new THREE.BoxGeometry(11.2, 2.6, 2.3), whiteArmMat);
    caaBody.position.set(5.6, 0, 0);
    caaBody.castShadow = true;
    caaGroup.add(caaBody);

    // Dark viewport strip along the Crew Access Arm
    const caaWindow = new THREE.Mesh(
      new THREE.BoxGeometry(8.5, 0.7, 2.38),
      new THREE.MeshStandardMaterial({ color: 0x161c26, roughness: 0.18, metalness: 0.85 })
    );
    caaWindow.position.set(5.4, 0.25, 0);
    caaGroup.add(caaWindow);

    tower.add(caaGroup);

    // Top lightning spire & aviation warning beacon
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.34, 15, 8), steelMat);
    spire.position.set(0, towerH + 7.5, 0);
    tower.add(spire);

    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 10), this.beaconMat);
    beacon.position.set(0, towerH + 15.2, 0);
    tower.add(beacon);

    parent.add(tower);
  }

  private buildStrongback(parent: THREE.Group): void {
    const sbWhite = new THREE.MeshStandardMaterial({
      color: 0xd9dde2,
      roughness: 0.42,
      metalness: 0.32,
    });
    const darkSteel = new THREE.MeshStandardMaterial({
      color: 0x2d323a,
      roughness: 0.52,
      metalness: 0.78,
    });
    const cryoPipe = new THREE.MeshStandardMaterial({
      color: 0xe8edf2,
      roughness: 0.28,
      metalness: 0.6,
    });

    // Iconic SpaceX SLC-40 Transporter-Erector (Strongback) cradling behind rocket (-X side)
    const sb = new THREE.Group();
    sb.position.set(-5.9, LAUNCH_MOUNT_TOP_Y, 0);
    sb.rotation.z = 0.048; // Slight pre-launch throw-back lean

    const sbH = 62;
    const widthZ = 3.2;
    const depthX = 2.4;

    // 4 main open-truss chords
    const chordGeo = new THREE.BoxGeometry(0.42, sbH, 0.42);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const chord = new THREE.Mesh(chordGeo, sbWhite);
        chord.position.set(-1.3 + sx * (depthX * 0.5), sbH * 0.5, sz * (widthZ * 0.5));
        chord.castShadow = true;
        sb.add(chord);
      }
    }

    // Cross rungs & diagonal trusses every 4 meters
    const bayH = 4.0;
    const rungGeo = new THREE.BoxGeometry(depthX, 0.28, widthZ);
    const diagGeo = new THREE.BoxGeometry(0.18, Math.hypot(bayH, widthZ), 0.18);
    const diagAngle = Math.atan2(widthZ, bayH);

    for (let y = 2; y <= sbH; y += bayH) {
      const rung = new THREE.Mesh(rungGeo, darkSteel);
      rung.position.set(-1.3, y, 0);
      sb.add(rung);

      const dBack = new THREE.Mesh(diagGeo, sbWhite);
      dBack.position.set(-1.3 - depthX * 0.5, y + bayH * 0.5, 0);
      dBack.rotation.x = (Math.floor(y / bayH) % 2 === 0 ? 1 : -1) * diagAngle;
      sb.add(dBack);
    }

    // Vertical white insulated LOX & RP-1 umbilical fuel risers
    for (const zOff of [-0.9, 0.9]) {
      const riser = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 52, 10), cryoPipe);
      riser.position.set(-0.2, 26, zOff);
      sb.add(riser);
    }

    // Twin hydraulic erection pistons at Strongback base
    for (const zOff of [-1.8, 1.8]) {
      const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 14, 10), darkSteel);
      piston.position.set(-5.8, 5.2, zOff);
      piston.rotation.z = -0.62;
      piston.castShadow = true;
      sb.add(piston);
    }

    // Upper stage quick-disconnect cradle head & stabilizer arms
    const qdHead = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.2, 3.8), darkSteel);
    qdHead.position.set(0.35, 51.5, 0);
    qdHead.castShadow = true;
    sb.add(qdHead);

    const midClamp = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.3, 3.4), darkSteel);
    midClamp.position.set(0.2, 33.5, 0);
    sb.add(midClamp);

    parent.add(sb);
  }

  private buildLatticeLightningTowers(parent: THREE.Group): void {
    const mastSteel = new THREE.MeshStandardMaterial({
      color: 0x8f97a0,
      roughness: 0.52,
      metalness: 0.62,
    });
    const concreteBase = new THREE.MeshStandardMaterial({
      map: this.textures.concreteAlbedo,
      roughness: 0.9,
    });

    // Positioned outside the main camera sightlines on the four pad perimeter corners
    const mastOffsets: [number, number][] = [
      [64, 64],
      [-64, 64],
      [64, -64],
      [-64, -64],
    ];

    const mastH = 88;
    const baseHalfW = 2.4;
    const topHalfW = 0.55;

    for (const [mx, mz] of mastOffsets) {
      const groundY = getCapeTerrainElevationM(mx, mz) - curvatureDropM(mx, mz);
      const tower = new THREE.Group();
      tower.position.set(mx, groundY, mz);

      // Concrete pedestal footing
      const footing = new THREE.Mesh(new THREE.BoxGeometry(6.2, 2.2, 6.2), concreteBase);
      footing.position.y = 1.1;
      footing.receiveShadow = true;
      tower.add(footing);

      // Tapered 4-leg open steel lattice tower (realistic SLC-40 lightning masts!)
      const legLen = Math.hypot(mastH, baseHalfW - topHalfW);
      const tilt = Math.atan2(baseHalfW - topHalfW, mastH);
      const legGeo = new THREE.CylinderGeometry(0.14, 0.22, legLen, 6);

      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const leg = new THREE.Mesh(legGeo, mastSteel);
          const midW = (baseHalfW + topHalfW) * 0.5;
          leg.position.set(sx * midW, 2 + mastH * 0.5, sz * midW);
          leg.rotation.z = sx * tilt;
          leg.rotation.x = -sz * tilt;
          leg.castShadow = true;
          tower.add(leg);
        }
      }

      // Horizontal ring collars every 11m
      for (let h = 11; h <= mastH; h += 11) {
        const t = h / mastH;
        const w = (baseHalfW * (1 - t) + topHalfW * t) * 2;
        const ring = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, w), mastSteel);
        ring.position.y = 2 + h;
        tower.add(ring);
      }

      // Top copper-tip lightning rod & red warning beacon
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.16, 8, 6), mastSteel);
      tip.position.y = 2 + mastH + 4;
      tower.add(tip);

      const light = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 8), this.beaconMat);
      light.position.y = 2 + mastH + 8.3;
      tower.add(light);

      parent.add(tower);
    }
  }

  private buildPropellantTankFarm(parent: THREE.Group): void {
    const tankMat = new THREE.MeshStandardMaterial({
      map: this.textures.tankPanelAlbedo,
      roughness: 0.36,
      metalness: 0.24,
    });
    const pipeSteel = new THREE.MeshStandardMaterial({
      color: 0x7e8790,
      roughness: 0.42,
      metalness: 0.72,
    });
    const bermMat = new THREE.MeshStandardMaterial({
      map: this.textures.concreteAlbedo,
      roughness: 0.9,
    });

    // 1. Cryogenic LOX spherical storage tanks (northwest of pad) with concrete containment berms & piping
    const loxSpecs: [number, number, number][] = [
      [-86, -68, 11.2],
      [-116, -74, 9.2],
    ];
    for (const [tx, tz, rad] of loxSpecs) {
      const gy = getCapeTerrainElevationM(tx, tz) - curvatureDropM(tx, tz);

      // Concrete containment ring berm
      const berm = new THREE.Mesh(new THREE.CylinderGeometry(rad + 5, rad + 6.5, 1.4, 24), bermMat);
      berm.position.set(tx, gy + 0.7, tz);
      berm.receiveShadow = true;
      parent.add(berm);

      // Insulated spherical LOX vessel
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(rad, 32, 24), tankMat);
      sphere.position.set(tx, gy + rad + 3.4, tz);
      sphere.castShadow = true;
      sphere.receiveShadow = true;
      parent.add(sphere);

      // 8 structural steel support columns
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.35, rad + 3.5, 8), pipeSteel);
        leg.position.set(
          tx + Math.cos(a) * rad * 0.76,
          gy + (rad + 3.5) * 0.5,
          tz + Math.sin(a) * rad * 0.76
        );
        leg.castShadow = true;
        parent.add(leg);
      }

      // Cryogenic feed pipe leading from sphere toward the pad
      const feedPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 54, 10), pipeSteel);
      feedPipe.rotation.z = Math.PI / 2;
      feedPipe.rotation.y = -0.62;
      feedPipe.position.set(tx + 24, gy + 2.2, tz + 18);
      parent.add(feedPipe);
    }

    // 2. Horizontal RP-1 kerosene tanks on concrete cradles (west-southwest of pad)
    for (let i = 0; i < 3; i++) {
      const tx = -94 - i * 11.5;
      const tz = 62;
      const gy = getCapeTerrainElevationM(tx, tz) - curvatureDropM(tx, tz);

      const tank = new THREE.Mesh(new THREE.CapsuleGeometry(3.0, 20, 12, 20), tankMat);
      tank.rotation.x = Math.PI / 2;
      tank.position.set(tx, gy + 4.4, tz);
      tank.castShadow = true;
      tank.receiveShadow = true;
      parent.add(tank);

      // Twin concrete saddle cradles per tank
      for (const zOff of [-7.5, 7.5]) {
        const saddle = new THREE.Mesh(new THREE.BoxGeometry(5.6, 2.8, 1.4), bermMat);
        saddle.position.set(tx, gy + 1.4, tz + zOff);
        saddle.castShadow = true;
        parent.add(saddle);
      }
    }

    // 3. Elevated Water Deluge Tower (multi-leg steel frame instead of plain pole)
    const wtX = -68, wtZ = -124;
    const wtY = getCapeTerrainElevationM(wtX, wtZ) - curvatureDropM(wtX, wtZ);
    const wtTank = new THREE.Mesh(new THREE.CylinderGeometry(8.4, 7.8, 10.5, 24), tankMat);
    wtTank.position.set(wtX, wtY + 37, wtZ);
    wtTank.castShadow = true;
    parent.add(wtTank);

    const wtCap = new THREE.Mesh(new THREE.ConeGeometry(8.5, 3.2, 24), tankMat);
    wtCap.position.set(wtX, wtY + 43.8, wtZ);
    parent.add(wtCap);

    // Central riser + 6 angled support legs
    const wtRiser = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.6, 33, 12), pipeSteel);
    wtRiser.position.set(wtX, wtY + 16.5, wtZ);
    wtRiser.castShadow = true;
    parent.add(wtRiser);

    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.42, 34, 8), pipeSteel);
      leg.position.set(wtX + Math.cos(a) * 5.8, wtY + 16.5, wtZ + Math.sin(a) * 5.8);
      leg.castShadow = true;
      parent.add(leg);
    }
  }

  private buildIndustrialFacilities(parent: THREE.Group): void {
    const hangarTex = this.textures.corrugatedAlbedo.clone();
    hangarTex.repeat.set(6, 2);
    hangarTex.needsUpdate = true;
    const hangarBump = this.textures.corrugatedBump.clone();
    hangarBump.repeat.set(6, 2);
    hangarBump.needsUpdate = true;

    const hangarMat = new THREE.MeshStandardMaterial({
      map: hangarTex,
      bumpMap: hangarBump,
      bumpScale: 0.12,
      roughness: 0.58,
      metalness: 0.34,
    });

    const roofMat = new THREE.MeshStandardMaterial({
      color: 0x89929c,
      roughness: 0.68,
      metalness: 0.42,
    });

    const darkSteel = new THREE.MeshStandardMaterial({
      color: 0x2a3038,
      roughness: 0.6,
      metalness: 0.55,
    });

    const concreteMat = new THREE.MeshStandardMaterial({
      map: this.textures.concreteAlbedo,
      roughness: 0.9,
    });

    // 1. SLC-40 Horizontal Integration Facility (HIF) — positioned south-southwest matching USGS ortho!
    const hifX = -38, hifZ = 215;
    const hifY = getCapeTerrainElevationM(hifX, hifZ) - curvatureDropM(hifX, hifZ);
    const hifGroup = new THREE.Group();
    hifGroup.position.set(hifX, hifY, hifZ);
    hifGroup.rotation.y = -0.18;

    // Concrete apron foundation slab
    const hifApron = new THREE.Mesh(new THREE.BoxGeometry(58, 0.5, 118), concreteMat);
    hifApron.position.y = 0.25;
    hifApron.receiveShadow = true;
    hifGroup.add(hifApron);

    // Main corrugated hangar hall
    const hifMain = new THREE.Mesh(new THREE.BoxGeometry(40, 22, 92), hangarMat);
    hifMain.position.set(0, 11.2, 0);
    hifMain.castShadow = true;
    hifMain.receiveShadow = true;
    hifGroup.add(hifMain);

    // Sloped standing-seam industrial roof + rooftop HVAC mechanical units
    const hifRoof = new THREE.Mesh(new THREE.BoxGeometry(41.4, 1.4, 93.4), roofMat);
    hifRoof.position.set(0, 22.7, 0);
    hifRoof.castShadow = true;
    hifGroup.add(hifRoof);

    for (const zOff of [-28, 0, 28]) {
      const hvac = new THREE.Mesh(new THREE.BoxGeometry(7.5, 2.6, 5.5), darkSteel);
      hvac.position.set(-8, 24.6, zOff);
      hvac.castShadow = true;
      hifGroup.add(hvac);
    }

    // Tall recessed hangar sliding blast doors facing north toward SLC-40 pad
    const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(22, 18.5, 1.6), darkSteel);
    doorFrame.position.set(0, 9.5, -46.1);
    hifGroup.add(doorFrame);

    // Adjacent operations annex wing
    const annex = new THREE.Mesh(new THREE.BoxGeometry(16, 11, 48), hangarMat);
    annex.position.set(-28, 5.7, 10);
    annex.castShadow = true;
    annex.receiveShadow = true;
    hifGroup.add(annex);

    parent.add(hifGroup);

    // 2. Launch Control Support Bunker & Equipment Building
    const bX = -158, bZ = 105;
    const bY = getCapeTerrainElevationM(bX, bZ) - curvatureDropM(bX, bZ);
    const bunker = new THREE.Mesh(new THREE.BoxGeometry(38, 10.5, 24), hangarMat);
    bunker.position.set(bX, bY + 5.25, bZ);
    bunker.castShadow = true;
    bunker.receiveShadow = true;
    parent.add(bunker);

    const bunkerRoof = new THREE.Mesh(new THREE.BoxGeometry(39.5, 0.9, 25.5), roofMat);
    bunkerRoof.position.set(bX, bY + 10.9, bZ);
    parent.add(bunkerRoof);
  }

  /**
   * Adds authentic SLC-40 ground-level aerospace micro-realism:
   * - Stadium floodlight stanchions around the concrete pad perimeter
   * - Elevated steel cryogenic pipe trestles connecting LOX farm to launch mount
   * - Telemetry tracking radome & dish near the support bunker
   * - Concrete Jersey safety barriers along the rollout ramp
   */
  private buildPadMicroDetails(parent: THREE.Group): void {
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x626b75,
      roughness: 0.48,
      metalness: 0.72,
    });
    const lampGlowMat = new THREE.MeshBasicMaterial({ color: 0xfff1d4 });
    const barrierMat = new THREE.MeshStandardMaterial({
      map: this.textures.concreteAlbedo,
      roughness: 0.92,
      metalness: 0.04,
    });
    const radomeMat = new THREE.MeshStandardMaterial({
      color: 0xe8edf2,
      roughness: 0.36,
      metalness: 0.12,
    });

    // 1. Four stadium floodlight masts flanking the launchpad apron
    const floodPositions: [number, number][] = [
      [38, 28],
      [-38, 30],
      [38, -30],
      [-36, -34],
    ];
    for (const [fx, fz] of floodPositions) {
      const gy = getCapeTerrainElevationM(fx, fz) - curvatureDropM(fx, fz);
      const mast = new THREE.Group();
      mast.position.set(fx, gy, fz);
      mast.rotation.y = Math.atan2(-fx, -fz);

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, 24, 8), steelMat);
      pole.position.y = 12;
      pole.castShadow = true;
      mast.add(pole);

      const crossbar = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.35, 0.35), steelMat);
      crossbar.position.set(0, 23.6, 0);
      mast.add(crossbar);

      for (let k = -1.6; k <= 1.61; k += 0.8) {
        const housing = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.42, 0.45), steelMat);
        housing.position.set(k, 24.0, 0.18);
        housing.rotation.x = 0.42;
        mast.add(housing);

        const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.34), lampGlowMat);
        lens.position.set(k, 23.92, 0.42);
        lens.rotation.x = 0.42;
        mast.add(lens);
      }

      parent.add(mast);
    }

    // 2. Elevated cryogenic pipe trestle bridges connecting LOX spheres to the launchpad
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      const px = -78 + t * 44;
      const pz = -58 + t * 42;
      const gy = getCapeTerrainElevationM(px, pz) - curvatureDropM(px, pz);
      const stanchion = new THREE.Mesh(new THREE.BoxGeometry(0.32, 3.6, 2.4), steelMat);
      stanchion.position.set(px, gy + 1.8, pz);
      stanchion.rotation.y = -0.78;
      stanchion.castShadow = true;
      parent.add(stanchion);
    }

    // 3. White geodesic telemetry tracking radome beside Launch Control Support Bunker
    const rx = -132, rz = 88;
    const ry = getCapeTerrainElevationM(rx, rz) - curvatureDropM(rx, rz);
    const radomeBase = new THREE.Mesh(new THREE.CylinderGeometry(3.8, 4.4, 5.2, 16), barrierMat);
    radomeBase.position.set(rx, ry + 2.6, rz);
    radomeBase.castShadow = true;
    parent.add(radomeBase);

    const radomeBall = new THREE.Mesh(new THREE.IcosahedronGeometry(4.6, 2), radomeMat);
    radomeBall.position.set(rx, ry + 8.6, rz);
    radomeBall.castShadow = true;
    parent.add(radomeBall);

    // 4. Concrete Jersey safety barriers lining both sides of the rollout ramp
    const barrierGeo = new THREE.BoxGeometry(0.75, 1.05, 4.8);
    for (const side of [-1, 1]) {
      for (let k = 0; k < 5; k++) {
        const bx = -8 + side * 8.6 - k * 1.1;
        const bz = 34 + k * 6.2;
        const by = getCapeTerrainElevationM(bx, bz) - curvatureDropM(bx, bz);
        const b = new THREE.Mesh(barrierGeo, barrierMat);
        b.position.set(bx, by + 0.52, bz);
        b.rotation.y = -0.22;
        b.castShadow = true;
        b.receiveShadow = true;
        parent.add(b);
      }
    }
  }

  /**
   * Subtle animated 3D cryogenic LOX boil-off vapor drifting from the Strongback umbilical
   * and LOX storage tanks (pure 3D shaded geometry, zero flat billboard image cards!).
   */
  private buildCryoVentVapor(parent: THREE.Group): void {
    const puffGeo = new THREE.IcosahedronGeometry(1.0, 1);
    const puffMat = new THREE.MeshStandardMaterial({
      color: 0xeef4fa,
      roughness: 0.98,
      metalness: 0.0,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    });

    const vents: THREE.Vector3[] = [
      new THREE.Vector3(-4.2, LAUNCH_MOUNT_TOP_Y + 49.5, 0.2), // Strongback upper LOX vent
      new THREE.Vector3(-4.8, LAUNCH_MOUNT_TOP_Y + 32.0, -0.4), // Mid-stage umbilical vent
      new THREE.Vector3(-86, getCapeTerrainElevationM(-86, -68) + 23.0, -68), // LOX sphere flare
    ];

    for (const origin of vents) {
      for (let i = 0; i < 6; i++) {
        const mesh = new THREE.Mesh(puffGeo, puffMat);
        mesh.position.copy(origin);
        mesh.renderOrder = 16;
        parent.add(mesh);
        this.cryoVentPuffs.push({
          mesh,
          basePos: origin.clone(),
          phase: i / 6,
          speed: 0.18 + (i % 3) * 0.04,
        });
      }
    }
  }

  private buildRoadsAndParking(parent: THREE.Group): void {
    const roadTex = this.textures.asphaltAlbedo.clone();
    roadTex.repeat.set(14, 1);
    roadTex.needsUpdate = true;

    const roadMat = new THREE.MeshStandardMaterial({
      map: roadTex,
      roughness: 0.9,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });

    const addRoad = (x0: number, z0: number, x1: number, z1: number, width: number) => {
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const cx = (x0 + x1) * 0.5;
      const cz = (z0 + z1) * 0.5;
      const gy = getCapeTerrainElevationM(cx, cz) - curvatureDropM(cx, cz);

      const segTex = this.textures.asphaltAlbedo.clone();
      segTex.repeat.set(Math.max(1, len / 22), 1);
      segTex.needsUpdate = true;

      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(len, 0.22, width),
        new THREE.MeshStandardMaterial({
          map: segTex,
          roughness: 0.9,
          metalness: 0.04,
        })
      );
      mesh.position.set(cx, gy + 0.14, cz);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.receiveShadow = true;
      parent.add(mesh);
    };

    // Rollout way connecting HIF hangar to SLC-40 ramp
    addRoad(-32, 165, -10, 62, 14);
    // Pad access road connecting west to coastal highway
    addRoad(-158, 105, -44, 24, 10);
    // Access spur to LZ-1 recovery pad
    addRoad(-160, 120, LANDING_PAD_OFFSET_LOCAL.eastM + 38, LANDING_PAD_OFFSET_LOCAL.southM, 9.5);

    // Asphalt parking lot beside support bunker
    const pX = -158, pZ = 136;
    const pY = getCapeTerrainElevationM(pX, pZ) - curvatureDropM(pX, pZ);
    const lot = new THREE.Mesh(new THREE.BoxGeometry(42, 0.18, 22), roadMat);
    lot.position.set(pX, pY + 0.12, pZ);
    lot.receiveShadow = true;
    parent.add(lot);
  }

  private buildLandingPadLZ1(parent: THREE.Group): void {
    const lx = LANDING_PAD_OFFSET_LOCAL.eastM;
    const lz = LANDING_PAD_OFFSET_LOCAL.southM;
    const r = LANDING_PAD_OFFSET_LOCAL.radiusM;
    const drop = curvatureDropM(lx, lz);
    const padTopY = LANDING_PAD_TOP_Y - drop;

    const lzGroup = new THREE.Group();
    lzGroup.position.set(lx, padTopY, lz);

    const concreteSide = new THREE.MeshStandardMaterial({
      map: this.textures.concreteAlbedo,
      roughness: 0.9,
    });
    const topTargetMat = new THREE.MeshStandardMaterial({
      map: this.textures.lz1PadAlbedo,
      bumpMap: this.textures.concreteBump,
      bumpScale: 0.08,
      roughness: 0.86,
      metalness: 0.04,
    });

    // Concrete cylindrical slab with scorched painted LZ-1 target texture on top face
    const slab = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 2.8, 2.5, 40), [
      concreteSide,
      topTargetMat,
      concreteSide,
    ]);
    slab.position.y = -1.25;
    slab.receiveShadow = true;
    lzGroup.add(slab);

    // Perimeter light stanchions around LZ-1
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x767f88, metalness: 0.7, roughness: 0.4 });
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 7.5, 6), poleMat);
      pole.position.set(Math.cos(a) * (r + 5), 1.5, Math.sin(a) * (r + 5));
      lzGroup.add(pole);
    }

    parent.add(lzGroup);
  }

  /**
   * Builds a true sculpted 3D arched Florida Sabal palm frond (curved central rachis +
   * angled 3D tapered leaflets with vertex color sun-to-shade gradient — ZERO 2D image cards!).
   */
  private create3DPalmFrondGeometry(): THREE.BufferGeometry {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    const segs = 12;
    const frondLen = 3.6;

    const pushVert = (x: number, y: number, z: number, r: number, g: number, b: number) => {
      positions.push(x, y, z);
      colors.push(r, g, b);
      return positions.length / 3 - 1;
    };

    for (let i = 0; i < segs; i++) {
      const t0 = i / segs;
      const t1 = (i + 1) / segs;
      const tm = (t0 + t1) * 0.5;

      // Graceful parabolic downward arch along +Z
      const z0 = t0 * frondLen;
      const z1 = t1 * frondLen;
      const y0 = Math.sin(t0 * Math.PI * 0.72) * 0.78 - t0 * t0 * 1.15;
      const y1 = Math.sin(t1 * Math.PI * 0.72) * 0.78 - t1 * t1 * 1.15;
      const span = Math.sin(Math.pow(tm, 0.85) * Math.PI) * 1.18 + 0.14;

      // Rich organic Florida palm green (deeper olive near crown -> brighter sunlit sage toward tips)
      const rStem = 0.22 + tm * 0.1;
      const gStem = 0.34 + tm * 0.14;
      const bStem = 0.13 + tm * 0.06;

      const rTip = 0.3 + tm * 0.12;
      const gTip = 0.46 + tm * 0.14;
      const bTip = 0.16 + tm * 0.06;

      const c0 = pushVert(0, y0, z0, rStem, gStem, bStem);
      const c1 = pushVert(0, y1, z1, rStem, gStem, bStem);

      // Left & right drooping 3D leaflet blades with natural V-dihedral angle
      for (const side of [-1, 1]) {
        const tipX = side * span;
        const tipY = (y0 + y1) * 0.5 - span * 0.32;
        const tipZ = (z0 + z1) * 0.5 + 0.22;
        const tip = pushVert(tipX, tipY, tipZ, rTip, gTip, bTip);
        if (side > 0) {
          indices.push(c0, c1, tip);
        } else {
          indices.push(c0, tip, c1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Builds a curved, ringed 3D Sabal palm trunk geometry.
   */
  private createCurvedPalmTrunkGeometry(): THREE.BufferGeometry {
    const geo = new THREE.CylinderGeometry(0.16, 0.34, 7.6, 8, 10);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = (y + 3.8) / 7.6; // 0 at base -> 1 at crown
      // Natural wind-swept coastal curve + subtle horizontal bark ring ridges
      const bend = Math.sin(t * Math.PI * 0.85) * 0.65;
      const ringBump = 1 + 0.055 * Math.sin(t * 28.0);
      pos.setXYZ(i, pos.getX(i) * ringBump + bend, y, pos.getZ(i) * ringBump);
    }
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Builds an organic displaced 3D coastal saw-palmetto / sea-grape foliage clump.
   */
  private createOrganicScrubGeometry(): THREE.BufferGeometry {
    const geo = new THREE.IcosahedronGeometry(2.5, 2);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n =
        1.0 +
        0.26 * Math.sin(v.x * 2.4 + v.z * 2.1) +
        0.18 * Math.cos(v.y * 3.2 - v.x * 2.9);
      v.multiplyScalar(n);
      v.x *= 1.45;
      v.y *= v.y < 0 ? 0.3 : 0.62;
      v.z *= 1.35;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    return geo;
  }

  private buildFloridaCoastalVegetation(parent: THREE.Group): void {
    // 1. Authentic 3D Florida Coastal Sabal Palm Trees (curved ringed trunks + 9 real 3D arched fronds each!)
    const palmCount = 240;
    const frondsPerPalm = 9;
    const trunkGeo = this.createCurvedPalmTrunkGeometry();
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x6f6253,
      roughness: 0.94,
      metalness: 0.02,
    });

    const frondGeo = this.create3DPalmFrondGeometry();
    const frondMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.72,
      metalness: 0.03,
    });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, palmCount);
    const fronds = new THREE.InstancedMesh(frondGeo, frondMat, palmCount * frondsPerPalm);
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    fronds.castShadow = true;

    // 2. Dense organic 3D coastal Saw Palmetto & sea-grape scrub clusters with per-instance color variation
    const scrubCount = 520;
    const scrubGeo = this.createOrganicScrubGeometry();
    const scrubMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.93,
      metalness: 0.0,
    });
    const scrubs = new THREE.InstancedMesh(scrubGeo, scrubMat, scrubCount);
    scrubs.castShadow = true;
    scrubs.receiveShadow = true;

    let seed = 440192;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    const dummy = new THREE.Object3D();
    const colorTmp = new THREE.Color();
    const isClearZone = (x: number, z: number) => {
      if (Math.hypot(x, z) < 138) return true; // SLC-40 cleared concrete/gravel pad perimeter
      if (Math.hypot(x + 38, z - 215) < 92) return true; // HIF hangar
      if (Math.hypot(x + 158, z - 118) < 58) return true; // Bunker & parking
      if (
        Math.hypot(x - LANDING_PAD_OFFSET_LOCAL.eastM, z - LANDING_PAD_OFFSET_LOCAL.southM) < 84
      )
        return true;
      if (x > getCoastlineEastM(z) - 82) return true; // Sandy beach & Atlantic surf
      if (x < -520) return true; // Keep clear of western estuary marshes
      return false;
    };

    // Place Sabal palms naturally clustered near coastal dunes & inland scrub
    let pPlaced = 0;
    let fIdx = 0;
    let attempts = 0;
    while (pPlaced < palmCount && attempts < 3600) {
      attempts++;
      const x = -480 + rand() * 940;
      const z = -820 + rand() * 1640;
      if (isClearZone(x, z)) continue;

      const elev = getCapeTerrainElevationM(x, z);
      if (elev < 1.0) continue;

      const y = elev - curvatureDropM(x, z);
      const scale = 0.72 + rand() * 0.68;
      const yawTrunk = rand() * Math.PI * 2;
      const leanX = (rand() - 0.5) * 0.16;
      const leanZ = (rand() - 0.5) * 0.16;

      dummy.position.set(x, y + 3.6 * scale, z);
      dummy.rotation.set(leanX, yawTrunk, leanZ);
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(pPlaced, dummy.matrix);

      // Crown top position accounting for trunk curve & lean
      const topX = x + Math.cos(yawTrunk) * 0.25 * scale - Math.sin(leanZ) * 3.6 * scale;
      const topY = y + 7.2 * scale;
      const topZ = z - Math.sin(yawTrunk) * 0.25 * scale + Math.sin(leanX) * 3.6 * scale;

      for (let f = 0; f < frondsPerPalm; f++) {
        const tier = f < 5 ? 0 : 1;
        const yaw = (f / frondsPerPalm) * Math.PI * 2 + rand() * 0.38;
        const pitchTilt = tier === 0 ? 0.16 + rand() * 0.22 : -0.32 + rand() * 0.18;
        dummy.position.set(topX, topY - tier * 0.15 * scale, topZ);
        dummy.rotation.set(0, yaw, 0);
        dummy.rotateX(pitchTilt);
        const fScale = scale * (tier === 0 ? 1.0 : 0.82);
        dummy.scale.set(fScale, fScale, fScale);
        dummy.updateMatrix();
        fronds.setMatrixAt(fIdx++, dummy.matrix);
      }

      pPlaced++;
    }

    trunks.count = pPlaced;
    fronds.count = fIdx;
    trunks.instanceMatrix.needsUpdate = true;
    fronds.instanceMatrix.needsUpdate = true;

    // Place organic multi-toned coastal saw-palmetto scrub bushes
    let sPlaced = 0;
    attempts = 0;
    while (sPlaced < scrubCount && attempts < 5500) {
      attempts++;
      const x = -500 + rand() * 980;
      const z = -960 + rand() * 1920;
      if (isClearZone(x, z)) continue;

      const elev = getCapeTerrainElevationM(x, z);
      if (elev < 0.85) continue;

      const y = elev - curvatureDropM(x, z);
      const scale = 0.58 + rand() * 1.42;
      dummy.position.set(x, y + 0.55 * scale, z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.set(scale, scale * (0.68 + rand() * 0.48), scale);
      dummy.updateMatrix();
      scrubs.setMatrixAt(sPlaced, dummy.matrix);

      // Authentic coastal Florida foliage color palette variation
      const hue = 0.24 + (rand() - 0.5) * 0.08;
      const sat = 0.26 + rand() * 0.22;
      const lit = 0.15 + rand() * 0.13;
      colorTmp.setHSL(hue, sat, lit);
      scrubs.setColorAt(sPlaced, colorTmp);
      sPlaced++;
    }

    scrubs.count = sPlaced;
    scrubs.instanceMatrix.needsUpdate = true;
    if (scrubs.instanceColor) scrubs.instanceColor.needsUpdate = true;

    parent.add(trunks);
    parent.add(fronds);
    parent.add(scrubs);
  }

  public update(
    cameraPosECEF: Vec3d,
    sunDirECEF: Vec3d,
    horizonColor: THREE.Color,
    zenithColor: THREE.Color,
    cameraAltitudeM: number,
    dt: number
  ): void {
    const rel = subVec3(CAPE_FRAME.originECEF, cameraPosECEF);
    this.group.position.set(rel.x, rel.y, rel.z);

    this.beaconClock += dt;
    const blinkOn = Math.sin(this.beaconClock * 3.8) > -0.2;
    this.beaconMat.color.setHex(blinkOn ? 0xff2b1f : 0x4a0c0a);

    const distFromCape = Math.hypot(rel.x, rel.y, rel.z);
    this.terrainOcean.update(sunDirECEF, horizonColor, zenithColor, cameraAltitudeM, distFromCape);
    const structuresVisible = distFromCape < 32_000;
    this.localStructuresGroup.visible = structuresVisible;

    // Animate gentle pre-launch cryogenic LOX boil-off mist drifting eastward in coastal breeze
    if (structuresVisible && distFromCape < 1_800) {
      for (const puff of this.cryoVentPuffs) {
        puff.phase = (puff.phase + dt * puff.speed) % 1.0;
        const t = puff.phase;
        const driftX = t * 9.5;
        const riseY = t * 4.2 + Math.sin(t * 5.0 + puff.basePos.y) * 0.6;
        const driftZ = Math.cos(this.beaconClock * 0.7 + puff.phase * 6.28) * 1.1 * t;
        puff.mesh.position.set(
          puff.basePos.x + driftX,
          puff.basePos.y + riseY,
          puff.basePos.z + driftZ
        );
        const s = 0.55 + Math.sin(t * Math.PI) * 2.1;
        puff.mesh.scale.set(s * 1.25, s * 0.85, s);
      }
    }
  }
}

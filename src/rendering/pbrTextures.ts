import * as THREE from 'three/webgpu';

export interface FacilityTextures {
  concreteAlbedo: THREE.CanvasTexture;
  concreteBump: THREE.CanvasTexture;
  scorchedConcrete: THREE.CanvasTexture;
  corrugatedAlbedo: THREE.CanvasTexture;
  corrugatedBump: THREE.CanvasTexture;
  asphaltAlbedo: THREE.CanvasTexture;
  tankPanelAlbedo: THREE.CanvasTexture;
  lz1PadAlbedo: THREE.CanvasTexture;
  hazardStripe: THREE.CanvasTexture;
  palmFrondTex: THREE.CanvasTexture;
}

/**
 * Generates crisp, physically grounded PBR CanvasTextures for SLC-40 concrete,
 * scorched flame-trench surfaces, corrugated industrial hangars, cryogenic tanks,
 * asphalt access roads, LZ-1 markings, and realistic Florida Sabal palm fronds.
 */
export function createFacilityTextures(): FacilityTextures {
  const concrete = makeWeatheredConcrete(false);
  const scorched = makeWeatheredConcrete(true);
  const corrugated = makeCorrugatedMetal();

  return {
    concreteAlbedo: concrete.albedo,
    concreteBump: concrete.bump,
    scorchedConcrete: scorched.albedo,
    corrugatedAlbedo: corrugated.albedo,
    corrugatedBump: corrugated.bump,
    asphaltAlbedo: makeAsphaltRoad(),
    tankPanelAlbedo: makeCryoTankPanels(),
    lz1PadAlbedo: makeLZ1TargetPad(),
    hazardStripe: makeHazardStripe(),
    palmFrondTex: makePalmFrondTexture(),
  };
}

function makeSeededRand(seedInit: number): () => number {
  let s = seedInit >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeWeatheredConcrete(scorched: boolean): {
  albedo: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
} {
  const size = 512;
  const cA = document.createElement('canvas');
  const cB = document.createElement('canvas');
  cA.width = cB.width = size;
  cA.height = cB.height = size;
  const ctxA = cA.getContext('2d')!;
  const ctxB = cB.getContext('2d')!;
  const rand = makeSeededRand(scorched ? 7711 : 3341);

  ctxA.fillStyle = scorched ? '#3b3c3e' : '#969894';
  ctxA.fillRect(0, 0, size, size);
  ctxB.fillStyle = '#808080';
  ctxB.fillRect(0, 0, size, size);

  // Organic concrete aggregate & salt-air weathering blotches
  for (let i = 0; i < 420; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 8 + rand() * 44;
    const shade = scorched ? 28 + Math.floor(rand() * 42) : 112 + Math.floor(rand() * 56);
    const alpha = 0.06 + rand() * 0.14;
    ctxA.fillStyle = `rgba(${shade}, ${shade - 1}, ${shade - 4}, ${alpha})`;
    ctxA.beginPath();
    ctxA.arc(x, y, r, 0, Math.PI * 2);
    ctxA.fill();

    const bShade = 95 + Math.floor(rand() * 65);
    ctxB.fillStyle = `rgba(${bShade}, ${bShade}, ${bShade}, 0.18)`;
    ctxB.beginPath();
    ctxB.arc(x, y, r * 0.6, 0, Math.PI * 2);
    ctxB.fill();
  }

  // Fine mineral grain speckle
  for (let i = 0; i < 2800; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const v = scorched ? 20 + Math.floor(rand() * 55) : 90 + Math.floor(rand() * 90);
    ctxA.fillStyle = `rgba(${v},${v},${v},0.22)`;
    ctxA.fillRect(x, y, 2, 2);
    ctxB.fillStyle = `rgba(${v},${v},${v},0.28)`;
    ctxB.fillRect(x, y, 2, 2);
  }

  // Expansion joint grid lines (poured aerospace pad slabs)
  ctxA.strokeStyle = scorched ? 'rgba(18,18,20,0.65)' : 'rgba(65,67,64,0.42)';
  ctxA.lineWidth = 2;
  ctxB.strokeStyle = 'rgba(25,25,25,0.75)';
  ctxB.lineWidth = 3;
  for (let k = 0; k < size; k += 128) {
    ctxA.beginPath();
    ctxA.moveTo(k, 0);
    ctxA.lineTo(k, size);
    ctxA.moveTo(0, k);
    ctxA.lineTo(size, k);
    ctxA.stroke();

    ctxB.beginPath();
    ctxB.moveTo(k, 0);
    ctxB.lineTo(k, size);
    ctxB.moveTo(0, k);
    ctxB.lineTo(size, k);
    ctxB.stroke();
  }

  if (scorched) {
    // Rocket exhaust soot streaks down flame trench
    const grad = ctxA.createRadialGradient(size / 2, size / 2, 16, size / 2, size / 2, size * 0.48);
    grad.addColorStop(0, 'rgba(12, 11, 10, 0.72)');
    grad.addColorStop(0.55, 'rgba(32, 26, 22, 0.35)');
    grad.addColorStop(1, 'rgba(32, 26, 22, 0.0)');
    ctxA.fillStyle = grad;
    ctxA.fillRect(0, 0, size, size);
  }

  const albedo = new THREE.CanvasTexture(cA);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.anisotropy = 8;

  const bump = new THREE.CanvasTexture(cB);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.anisotropy = 8;

  return { albedo, bump };
}

function makeCorrugatedMetal(): {
  albedo: THREE.CanvasTexture;
  bump: THREE.CanvasTexture;
} {
  const size = 512;
  const cA = document.createElement('canvas');
  const cB = document.createElement('canvas');
  cA.width = cB.width = size;
  cA.height = cB.height = size;
  const ctxA = cA.getContext('2d')!;
  const ctxB = cB.getContext('2d')!;

  ctxA.fillStyle = '#c9cfd6';
  ctxA.fillRect(0, 0, size, size);
  ctxB.fillStyle = '#808080';
  ctxB.fillRect(0, 0, size, size);

  // Vertical industrial ribbed siding panels
  const ribW = 12;
  for (let x = 0; x < size; x += ribW) {
    const gradA = ctxA.createLinearGradient(x, 0, x + ribW, 0);
    gradA.addColorStop(0.0, '#adb5be');
    gradA.addColorStop(0.25, '#d7dce2');
    gradA.addColorStop(0.65, '#c6cdd4');
    gradA.addColorStop(1.0, '#9ba3ad');
    ctxA.fillStyle = gradA;
    ctxA.fillRect(x, 0, ribW, size);

    const gradB = ctxB.createLinearGradient(x, 0, x + ribW, 0);
    gradB.addColorStop(0.0, '#444444');
    gradB.addColorStop(0.3, '#dcdcdc');
    gradB.addColorStop(0.7, '#aaaaaa');
    gradB.addColorStop(1.0, '#383838');
    ctxB.fillStyle = gradB;
    ctxB.fillRect(x, 0, ribW, size);
  }

  // Horizontal structural girt seams + subtle coastal rain streaking
  ctxA.fillStyle = 'rgba(55, 62, 72, 0.35)';
  for (let y = 0; y < size; y += 128) {
    ctxA.fillRect(0, y, size, 3);
    ctxB.fillStyle = 'rgba(20,20,20,0.6)';
    ctxB.fillRect(0, y, size, 4);
  }

  // Subtle industrial blue-gray lower wainscot band
  ctxA.fillStyle = 'rgba(58, 72, 92, 0.22)';
  ctxA.fillRect(0, size * 0.78, size, size * 0.22);

  const albedo = new THREE.CanvasTexture(cA);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.anisotropy = 8;

  const bump = new THREE.CanvasTexture(cB);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.anisotropy = 8;

  return { albedo, bump };
}

function makeAsphaltRoad(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const rand = makeSeededRand(8812);

  ctx.fillStyle = '#383c42';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 4000; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const g = 42 + Math.floor(rand() * 36);
    ctx.fillStyle = `rgba(${g},${g},${g + 2},0.35)`;
    ctx.fillRect(x, y, 2, 2);
  }

  // White edge shoulder lines
  ctx.fillStyle = 'rgba(215, 220, 224, 0.75)';
  ctx.fillRect(0, 22, size, 7);
  ctx.fillRect(0, size - 29, size, 7);

  // Dashed yellow centerline
  ctx.fillStyle = 'rgba(222, 184, 72, 0.8)';
  for (let x = 16; x < size; x += 96) {
    ctx.fillRect(x, size / 2 - 4, 48, 8);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function makeCryoTankPanels(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#e7ebef';
  ctx.fillRect(0, 0, size, size);

  // Welded spherical/cylindrical tank plate seams & subtle grime
  ctx.strokeStyle = 'rgba(130, 140, 152, 0.35)';
  ctx.lineWidth = 2;
  for (let i = 0; i < size; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }

  // Hazard band & LOX/RP-1 stripe accent
  ctx.fillStyle = 'rgba(46, 98, 165, 0.72)';
  ctx.fillRect(0, size * 0.46, size, 16);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function makeLZ1TargetPad(): THREE.CanvasTexture {
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const rand = makeSeededRand(1969);

  ctx.fillStyle = '#8b8e8b';
  ctx.fillRect(0, 0, size, size);

  // Concrete aggregate & radial scorch marks from previous booster landings!
  for (let i = 0; i < 650; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 6 + rand() * 36;
    const v = 115 + Math.floor(rand() * 45);
    ctx.fillStyle = `rgba(${v},${v},${v - 2},0.14)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const cx = size / 2;
  const cy = size / 2;

  // Previous landing exhaust soot ring
  const soot = ctx.createRadialGradient(cx, cy, 20, cx, cy, 340);
  soot.addColorStop(0, 'rgba(38, 36, 34, 0.52)');
  soot.addColorStop(0.5, 'rgba(54, 52, 48, 0.22)');
  soot.addColorStop(1, 'rgba(54, 52, 48, 0)');
  ctx.fillStyle = soot;
  ctx.fillRect(0, 0, size, size);

  // Outer safety perimeter ring
  ctx.strokeStyle = 'rgba(235, 239, 242, 0.88)';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.arc(cx, cy, 445, 0, Math.PI * 2);
  ctx.stroke();

  // Inner concentric landing zone ring
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.arc(cx, cy, 225, 0, Math.PI * 2);
  ctx.stroke();

  // Bold SpaceX-inspired stylized X landing target
  ctx.strokeStyle = 'rgba(236, 240, 244, 0.92)';
  ctx.lineWidth = 34;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(cx - 125, cy - 125);
  ctx.lineTo(cx + 125, cy + 125);
  ctx.moveTo(cx + 125, cy - 125);
  ctx.lineTo(cx - 125, cy + 125);
  ctx.stroke();

  // Stenciled "LZ-1" pad callout
  ctx.fillStyle = 'rgba(235, 239, 242, 0.82)';
  ctx.font = '700 62px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('LZ-1', cx, cy + 325);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

function makeHazardStripe(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#d49d27';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#202226';
  for (let i = -size; i < size * 2; i += 48) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 24, 0);
    ctx.lineTo(i + 24 + size, size);
    ctx.lineTo(i + size, size);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makePalmFrondTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  // Feathery Florida coastal Sabal palm frond radiating from base
  ctx.strokeStyle = '#3b572d';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(w / 2, h - 8);
  ctx.lineTo(w / 2, 20);
  ctx.stroke();

  for (let i = 0; i < 24; i++) {
    const t = i / 23;
    const y = h - 22 - t * (h - 48);
    const span = Math.sin(t * Math.PI) * 105 + 14;
    const shade = 52 + Math.floor(t * 26);
    ctx.strokeStyle = `rgb(${Math.floor(shade * 0.72)}, ${shade + 22}, ${Math.floor(shade * 0.52)})`;
    ctx.lineWidth = 5.5 - t * 2.0;

    // Left & right leaflets
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(w / 2, y);
      ctx.quadraticCurveTo(w / 2 + dir * span * 0.6, y - 16, w / 2 + dir * span, y + 6);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

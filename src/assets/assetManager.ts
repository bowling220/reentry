import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const assetUrl = (path: string): string => `${import.meta.env.BASE_URL}assets/${path}`;

export interface LoadedAssets {
  stage1Model: THREE.Group | null;
  upperStageModel: THREE.Group | null;
  payloadModel: THREE.Group | null;
  saturnModel: THREE.Group | null;
  earthDayMap: THREE.Texture | null;
  earthNightMap: THREE.Texture | null;
  earthCloudsMap: THREE.Texture | null;
  capeSatLocal: THREE.Texture | null;
  capeSatMid: THREE.Texture | null;
  capeSatWide: THREE.Texture | null;
}

/**
 * Loads external 3D spacecraft GLB models (Space Radar Falcon 9 & Starlink v1, MIT License),
 * public-domain USGS National Map Cape Canaveral satellite orthoimagery,
 * and planetary Earth textures (Solar System Scope / NASA Blue Marble, CC BY 4.0).
 */
export class AssetManager {
  private readonly gltfLoader: GLTFLoader;
  private readonly textureLoader: THREE.TextureLoader;

  constructor() {
    this.gltfLoader = new GLTFLoader();
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);
    this.textureLoader = new THREE.TextureLoader();
  }

  public async loadAll(onProgress?: (label: string) => void): Promise<LoadedAssets> {
    onProgress?.('Loading Falcon 9, Saturn V, payload, USGS imagery & 8K Earth maps…');

    const [
      stage1Model,
      upperStageModel,
      payloadModel,
      saturnModel,
      earthDayMap,
      earthNightMap,
      earthCloudsMap,
      capeSatLocal,
      capeSatMid,
      capeSatWide,
    ] = await Promise.all([
      this.loadGlb(assetUrl('models/falcon9-stage1.glb')),
      this.loadGlb(assetUrl('models/falcon9-upper.glb')),
      this.loadGlb(assetUrl('models/starlink-v1.glb')),
      this.loadGlb(assetUrl('models/saturn-v-nasa.glb')),
      this.loadTexture(assetUrl('textures/earth_daymap.jpg'), true, true),
      this.loadTexture(assetUrl('textures/earth_nightmap.jpg'), true, true),
      this.loadTexture(assetUrl('textures/earth_clouds.jpg'), false, true),
      this.loadTexture(assetUrl('textures/cape_sat_local.png'), true, false),
      this.loadTexture(assetUrl('textures/cape_sat_mid.png'), true, false),
      this.loadTexture(assetUrl('textures/cape_sat_wide.png'), true, false),
    ]);

    return {
      stage1Model,
      upperStageModel,
      payloadModel,
      saturnModel,
      earthDayMap,
      earthNightMap,
      earthCloudsMap,
      capeSatLocal,
      capeSatMid,
      capeSatWide,
    };
  }

  private async loadGlb(url: string): Promise<THREE.Group | null> {
    try {
      const gltf = await this.gltfLoader.loadAsync(url);
      return gltf.scene;
    } catch (err) {
      console.warn(`[AssetManager] Failed to load GLB ${url}:`, err);
      return null;
    }
  }

  private async loadTexture(
    url: string,
    isSRGB: boolean,
    repeatU: boolean
  ): Promise<THREE.Texture | null> {
    try {
      const tex = await this.textureLoader.loadAsync(url);
      tex.wrapS = repeatU ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.anisotropy = 16;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      if (isSRGB) {
        tex.colorSpace = THREE.SRGBColorSpace;
      }
      tex.needsUpdate = true;
      return tex;
    } catch (err) {
      console.warn(`[AssetManager] Failed to load texture ${url}:`, err);
      return null;
    }
  }
}

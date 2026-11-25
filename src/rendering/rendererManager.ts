import * as THREE from 'three/webgpu';

export type RendererBackendName = 'WebGPU' | 'WebGL 2';

/**
 * Manages the Three.js WebGPURenderer (with automatic WebGL 2 fallback)
 * and viewport sizing, tone mapping, and shadow settings.
 */
export class RendererManager {
  public readonly renderer: THREE.WebGPURenderer;
  public backendName: RendererBackendName = 'WebGPU';
  private readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGPURenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
  }

  public async init(): Promise<void> {
    await this.renderer.init();
    const backend = this.renderer.backend as { isWebGPUBackend?: boolean } | undefined;
    this.backendName = backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
  }

  public resize(camera: THREE.PerspectiveCamera): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  public render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.renderer.render(scene, camera);
  }
}

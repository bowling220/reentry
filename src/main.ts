import './style.css';
import { AssetManager } from './assets/assetManager';
import { AerospaceAudioEngine } from './audio/audioEngine';
import { CAMERA_MODE_LIST, CameraController } from './camera/cameraController';
import { InputManager } from './input/inputManager';
import { RendererManager } from './rendering/rendererManager';
import { SceneController } from './rendering/sceneController';
import { LocalPhysicsWorld } from './simulation/localPhysics';
import { PlanetSimulation } from './simulation/planetSimulation';
import { SimulationClock, TIME_WARP_LEVELS } from './simulation/simulationLoop';
import { SpacecraftManager } from './simulation/spacecraftManager';
import { computeTelemetry } from './simulation/telemetry';
import { FlightHud } from './ui/hud';

async function bootstrap(): Promise<void> {
  const viewportEl = document.getElementById('viewport')!;
  const hudRootEl = document.getElementById('hud-root')!;

  const initBanner = document.createElement('div');
  initBanner.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#050811;color:#d8e4f5;font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:0.12em;z-index:100;';
  initBanner.textContent = 'INITIALIZING REENTRY ORBITAL ENGINE…';
  document.body.appendChild(initBanner);

  const rendererManager = new RendererManager(viewportEl);
  const assetManager = new AssetManager();

  const [, , assets] = await Promise.all([
    LocalPhysicsWorld.initRapier(),
    rendererManager.init(),
    assetManager.loadAll((msg) => {
      initBanner.textContent = msg.toUpperCase();
    }),
  ]);

  const planet = new PlanetSimulation();
  const spacecraftManager = new SpacecraftManager();
  const clock = new SimulationClock();
  const input = new InputManager();
  const cameraController = new CameraController(viewportEl);
  const audio = new AerospaceAudioEngine();
  audio.bindUnlock();

  const selectSpacecraftById = (id: string) => {
    if (spacecraftManager.selectSpacecraft(id)) {
      cameraController.adaptDistanceForCraft(spacecraftManager.activeDynamics);
    }
  };

  const sceneController = new SceneController(assets, hudRootEl, selectSpacecraftById);

  const resetAll = () => {
    input.clear();
    planet.reset();
    spacecraftManager.reset();
    clock.reset();
    sceneController.reset();
    cameraController.resetView();
  };

  const triggerManualStage = () => {
    if (clock.paused) clock.togglePause();
    if (spacecraftManager.triggerStage()) {
      audio.playStageSeparation();
      cameraController.adaptDistanceForCraft(spacecraftManager.activeDynamics);
    }
  };

  const hud = new FlightHud(hudRootEl, {
    onLaunch: () => {
      if (clock.paused) clock.togglePause();
      const dyn = spacecraftManager.activeDynamics;
      if (dyn.engineIgnited) {
        dyn.throttle = 1.0;
      } else {
        dyn.triggerLaunchOrIgnition();
        if (dyn.justIgnited) audio.playIgnition();
      }
    },
    onStage: triggerManualStage,
    onTogglePause: () => {
      clock.togglePause();
    },
    onReset: resetAll,
    onSelectCamera: (mode) => {
      cameraController.setMode(mode);
    },
    onSelectTimeWarp: (scale) => {
      clock.setTimeScale(scale);
    },
    onToggleSasMode: () => {
      spacecraftManager.activeDynamics.cycleSasMode();
    },
    onToggleGear: () => {
      const dyn = spacecraftManager.activeDynamics;
      dyn.setLandingGear(!dyn.gearDeployed);
    },
    onToggleMap: () => {
      cameraController.toggleMapMode(spacecraftManager.activeDynamics);
    },
    onSelectSpacecraft: selectSpacecraftById,
    onToggleMute: () => {
      const muted = audio.toggleMute();
      hud.setAudioUiState(muted, audio.onboardSpaceAudio);
    },
    onVolumeChange: (vol) => {
      audio.setMasterVolume(vol);
    },
    onToggleSpaceAudio: () => {
      const onboard = audio.toggleOnboardSpaceAudio();
      hud.setAudioUiState(audio.muted, onboard);
    },
    onUiInteract: () => {
      audio.playUiClick();
    },
  });

  hud.setBackendName(rendererManager.backendName);
  hud.setAudioUiState(audio.muted, audio.onboardSpaceAudio);

  window.addEventListener('resize', () => {
    rendererManager.resize(cameraController.camera);
  });

  initBanner.remove();

  let lastFrameTime = performance.now();
  let smoothedFps = 60;
  let renderFailed = false;

  const frame = (now: number) => {
    if (renderFailed) return;
    requestAnimationFrame(frame);

    const realDt = Math.min(0.1, Math.max(0.0001, (now - lastFrameTime) / 1000));
    lastFrameTime = now;
    smoothedFps = smoothedFps * 0.92 + (1 / realDt) * 0.08;

    // Process UI/application hotkeys
    const actions = input.consumeAppActions();
    if (actions.cycleCamera) cameraController.cycleMode();
    if (actions.selectCameraIndex !== null && CAMERA_MODE_LIST[actions.selectCameraIndex]) {
      cameraController.setMode(CAMERA_MODE_LIST[actions.selectCameraIndex].id);
    }
    if (actions.togglePause) clock.togglePause();
    if (actions.resetFlight) resetAll();
    if (actions.toggleHelp) hud.toggleHelp();
    if (actions.toggleMap) cameraController.toggleMapMode(spacecraftManager.activeDynamics);
    if (actions.toggleCinematicHud) hud.toggleCinematicHud();
    if (actions.stagePressed) triggerManualStage();
    if (actions.cycleCraft !== 0) {
      spacecraftManager.cycleSpacecraft(actions.cycleCraft);
      cameraController.adaptDistanceForCraft(spacecraftManager.activeDynamics);
    }
    if (actions.warpStep !== 0) {
      const idx = TIME_WARP_LEVELS.indexOf(
        clock.requestedTimeScale as (typeof TIME_WARP_LEVELS)[number]
      );
      const nextIdx = Math.max(
        0,
        Math.min(TIME_WARP_LEVELS.length - 1, (idx < 0 ? 0 : idx) + actions.warpStep)
      );
      clock.setTimeScale(TIME_WARP_LEVELS[nextIdx]);
    }

    // Advance planetary & multi-spacecraft physics using fixed/RK4 steps + safe warp gating
    const { maxWarp, reason: warpReason } = spacecraftManager.computeMaxSafeWarp();
    const stepsExecuted = clock.advance(
      realDt,
      maxWarp,
      (stepDt) => {
        const flightInput = input.consumeFlightInput();
        planet.step(stepDt);
        spacecraftManager.stepAll(stepDt, flightInput, planet);

        const activeDyn = spacecraftManager.activeDynamics;
        if (activeDyn.justIgnited) audio.playIgnition();
        if (activeDyn.justShutdown) audio.playShutdown();
        if (activeDyn.justLanded) audio.playTouchdown();
        if (activeDyn.justCrashed) audio.playCrash();
      },
      warpReason
    );

    if (stepsExecuted === 0 && clock.paused) {
      const toggles = input.consumeMechanismToggles();
      const dyn = spacecraftManager.activeDynamics;
      if (toggles.sas) dyn.toggleSas();
      if (toggles.cycleSasMode) dyn.cycleSasMode();
      if (toggles.gear) dyn.setLandingGear(!dyn.gearDeployed);
    }

    const activeCraft = spacecraftManager.activeSpacecraft;
    const activeDyn = activeCraft.dynamics;

    // Update flight / orbital map camera
    cameraController.update(activeDyn, realDt);

    // Update 3D scene graph (all spacecraft, Earth, atmosphere, Cape Canaveral, orbital map)
    const vfxDt = clock.paused ? 0 : realDt * Math.min(clock.effectiveTimeScale, 4);
    sceneController.update(
      spacecraftManager,
      planet,
      cameraController.camera,
      cameraController.cameraPosECEF,
      cameraController.mapMode,
      vfxDt
    );

    // Update procedural aerospace audio
    audio.update(activeDyn, cameraController.cameraPosECEF, clock.paused, cameraController.mapMode);

    // Render frame with synchronous render failure guard
    try {
      rendererManager.render(sceneController.scene, cameraController.camera);
    } catch (error) {
      renderFailed = true;
      clock.paused = true;
      console.error('[REENTRY] Rendering stopped:', error);
      const notice = document.createElement('div');
      notice.setAttribute('role', 'alert');
      notice.style.cssText =
        'position:fixed;top:64px;left:50%;transform:translateX(-50%);padding:16px;background:#321c24;color:#fff;font:14px system-ui;z-index:200;';
      notice.textContent =
        'Flight paused because the view stopped rendering. Reload to restart.';
      document.body.appendChild(notice);
    }

    // Compute live flight + orbital telemetry
    const telemetry = computeTelemetry(activeDyn, planet);
    if (telemetry.orbital.classification === 'ORBITAL') {
      spacecraftManager.notifyOrbitAchievedIfNew(activeCraft);
    }

    // Flush flight event notifications to HUD toast stack
    for (const notice of spacecraftManager.consumeEvents()) {
      hud.pushToast(notice);
    }

    hud.update(
      telemetry,
      spacecraftManager,
      smoothedFps,
      cameraController.mode,
      cameraController.mapMode,
      clock.paused,
      clock.requestedTimeScale,
      clock.effectiveTimeScale,
      clock.warpCapReason
    );
  };

  requestAnimationFrame(frame);
}

bootstrap().catch((err) => {
  console.error('[REENTRY] Fatal bootstrap error:', err);
  document.body.innerHTML = `<div style="padding:32px;color:#ff8a8a;font-family:monospace;background:#090d16;height:100vh;">
    <h2>REENTRY Initialization Failed</h2>
    <pre style="margin-top:12px;white-space:pre-wrap;">${String(err)}</pre>
  </div>`;
});

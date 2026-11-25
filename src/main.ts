import './style.css';
import { AssetManager } from './assets/assetManager';
import { AerospaceAudioEngine } from './audio/audioEngine';
import { CAMERA_MODE_LIST, CameraController } from './camera/cameraController';
import { LaunchVehicleId } from './config/launchVehicles';
import { FlightComputerManager } from './flightComputer/flightComputerManager';
import { FlightDataRecorder } from './flightComputer/flightRecorder';
import { ProgramLibrary } from './flightComputer/programLibrary';
import { AUTO_DEMOS } from './flightComputer/demoPrograms';
import { RETURN_HOME_PROGRAM } from './flightComputer/coastalProgram';
import { configureDemoVehicle } from './simulation/demoFlights';
import { InputManager } from './input/inputManager';
import { RendererManager } from './rendering/rendererManager';
import { SceneController } from './rendering/sceneController';
import { NEUTRAL_FLIGHT_INPUT } from './simulation/flightDynamics';
import { LocalPhysicsWorld } from './simulation/localPhysics';
import { PlanetSimulation } from './simulation/planetSimulation';
import { FLIGHT_SCENARIOS, ScenarioId, loadFlightScenario } from './simulation/scenarios';
import { SimulationClock, TIME_WARP_LEVELS } from './simulation/simulationLoop';
import { SpacecraftManager } from './simulation/spacecraftManager';
import { computeTelemetry } from './simulation/telemetry';
import { EngineeringWorkspace, WorkspaceMode } from './ui/engineeringWorkspace';
import { FlightHud } from './ui/hud';

async function bootstrap(): Promise<void> {
  const viewportEl = document.getElementById('viewport')!;
  const hudRootEl = document.getElementById('hud-root')!;
  const workspaceRootEl = document.getElementById('workspace-root')!;

  const initBanner = document.createElement('div');
  initBanner.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#050811;color:#d8e4f5;font-family:"JetBrains Mono",monospace;font-size:12px;letter-spacing:0.12em;z-index:100;';
  initBanner.textContent = 'INITIALIZING REENTRY ORBITAL ENGINE…';
  document.body.appendChild(initBanner);

  const rendererManager = new RendererManager(viewportEl);
  const assetManager = new AssetManager();
  const programLibrary = new ProgramLibrary();

  const [, , assets] = await Promise.all([
    LocalPhysicsWorld.initRapier(),
    rendererManager.init(),
    assetManager.loadAll((msg) => {
      initBanner.textContent = msg.toUpperCase();
    }),
    programLibrary.init(),
  ]);

  const planet = new PlanetSimulation();
  const spacecraftManager = new SpacecraftManager();
  const clock = new SimulationClock();
  const input = new InputManager();
  const cameraController = new CameraController(viewportEl);
  const audio = new AerospaceAudioEngine();
  audio.bindUnlock();

  const fcManager = new FlightComputerManager();
  fcManager.syncSpacecraft(spacecraftManager);
  const recorder = new FlightDataRecorder();

  let currentScenario = FLIGHT_SCENARIOS[0];
  let demoRunning = false;
  let coastalTourCraftId: string | null = null;
  let lastCoastalPhase = '';
  const recoveryModes = new Map<string, string>();
  let selectedLaunchVehicle: LaunchVehicleId = 'falcon9';
  let workspace!: EngineeringWorkspace;

  const selectSpacecraftById = (id: string) => {
    if (spacecraftManager.selectSpacecraft(id)) {
      cameraController.adaptDistanceForCraft(spacecraftManager.activeDynamics);
      workspace?.syncActiveSpacecraft(id);
    }
  };

  const sceneController = new SceneController(assets, hudRootEl, selectSpacecraftById);
  sceneController.spacecraftVisuals.warmup = async group => {
    const scene = sceneController.scene.clone(false);
    scene.add(group);
    await rendererManager.renderer.compileAsync(scene, cameraController.camera, sceneController.scene);
    scene.remove(group);
  };

  const loadScenario = (scenarioId: ScenarioId, keepInstalledProgram: boolean) => {
    demoRunning = false;
    coastalTourCraftId = null;
    lastCoastalPhase = '';
    recoveryModes.clear();
    const prevCraft = spacecraftManager.activeSpacecraft;
    const prevFc = prevCraft ? fcManager.getComputer(prevCraft.id) : null;
    const savedProg =
      keepInstalledProgram && prevFc?.programId && prevFc.sourceCode
        ? {
            programId: prevFc.programId,
            programName: prevFc.programName,
            language: prevFc.language,
            code: prevFc.sourceCode,
          }
        : null;

    input.clear();
    fcManager.reset();
    clock.reset();
    recorder.reset();

    if (scenarioId !== 'prelaunch') selectedLaunchVehicle = 'falcon9';
    currentScenario = loadFlightScenario(scenarioId, spacecraftManager, planet, selectedLaunchVehicle);
    sceneController.reset();
    cameraController.resetView();
    cameraController.adaptDistanceForCraft(spacecraftManager.activeDynamics);

    fcManager.syncSpacecraft(spacecraftManager);
    if (savedProg) {
      fcManager.installProgram(
        spacecraftManager.activeId,
        savedProg.programId,
        savedProg.programName,
        savedProg.language,
        savedProg.code
      );
    }

    workspace?.setScenarioMeta(scenarioId, currentScenario.isSandbox);
    workspace?.syncActiveSpacecraft(spacecraftManager.activeId);

    spacecraftManager.pushEvent(
      currentScenario.isSandbox ? 'SANDBOX SCENARIO LOADED' : 'FLIGHT RESET',
      currentScenario.name,
      'info'
    );
  };

  const resetAll = () => {
    loadScenario(demoRunning ? 'prelaunch' : currentScenario.id, !demoRunning);
  };

  const triggerManualStage = () => {
    if (clock.paused) clock.togglePause();
    const craftBefore = spacecraftManager.activeSpacecraft;
    const actionBefore = spacecraftManager.getNextStageAction(craftBefore);
    if (spacecraftManager.triggerStage()) {
      audio.playStageSeparation();
      cameraController.adaptDistanceForCraft(spacecraftManager.activeDynamics);
      fcManager.syncSpacecraft(spacecraftManager);
      workspace?.syncActiveSpacecraft(spacecraftManager.activeId);
      recorder.recordEvent(
        craftBefore.id,
        planet.planetTimeS,
        craftBefore.dynamics.missionElapsedTimeS,
        actionBefore.label,
        'staging'
      );
      fcManager.notifyStagingEvent(craftBefore, actionBefore.label, spacecraftManager, planet);
    }
  };

  const triggerImmediateOverride = () => {
    const activeCraft = spacecraftManager.activeSpacecraft;
    const fc = fcManager.getComputer(activeCraft.id);
    const wasAutonomous = fc.authority === 'PROGRAM' || fc.authority === 'FAULT';
    fcManager.manualOverride(activeCraft, planet.planetTimeS);
    if (wasAutonomous) {
      spacecraftManager.pushEvent(
        'MANUAL OVERRIDE',
        `Pilot reclaimed control of ${activeCraft.name}.`,
        'warning'
      );
    }
  };

  fcManager.onStageRequested = (craftId: string) => {
    if (craftId === spacecraftManager.activeId) {
      triggerManualStage();
    }
  };

  const applyWorkspaceLayout = (mode: WorkspaceMode) => {
    document.body.classList.toggle('workspace-split', mode === 'SPLIT');
    document.body.classList.toggle('workspace-full', mode === 'FULL');
    rendererManager.resize(cameraController.camera);
  };

  workspace = new EngineeringWorkspace(
    workspaceRootEl,
    programLibrary,
    fcManager,
    recorder,
    spacecraftManager,
    planet,
    {
      onModeChange: applyWorkspaceLayout,
      onSplitResize: () => {
        rendererManager.resize(cameraController.camera);
      },
      onLoadScenario: (id, keepInstalledProgram) => {
        loadScenario(id, keepInstalledProgram);
      },
      onSelectSpacecraft: selectSpacecraftById,
      onUiClick: () => audio.playUiClick(),
    }
  );
  workspace.setScenarioMeta(currentScenario.id, currentScenario.isSandbox);

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
    onStartDemo: (id) => {
      const demo = AUTO_DEMOS.find(item => item.id === id);
      if (!demo) return;
      selectedLaunchVehicle = 'falcon9';
      loadScenario(demo.scenario, false);
      configureDemoVehicle(demo, spacecraftManager);
      fcManager.reset();
      fcManager.syncSpacecraft(spacecraftManager);
      sceneController.reset();
      cameraController.adaptDistanceForCraft(spacecraftManager.activeDynamics);
      workspace.syncActiveSpacecraft(spacecraftManager.activeId);
      workspace.setMode('CLOSED');
      const program = demo.program;
      fcManager.installProgram(spacecraftManager.activeId, program.id, program.name, program.language, program.code);
      fcManager.startProgram(spacecraftManager.activeSpacecraft, spacecraftManager, planet);
      demoRunning = true;
      coastalTourCraftId = id === 'coastal' ? spacecraftManager.activeId : null;
      clock.setTimeScale(2);
      spacecraftManager.pushEvent('AUTOMATIC DEMO', demo.name + ' — Esc for manual override.', 'info');
    },
    onReturnHome: () => {
      const craft = spacecraftManager.activeSpacecraft;
      if (!craft.dynamics.hasLiftedOff || !craft.dynamics.hasLandingGear || craft.dynamics.config.maxThrustVacN <= 0 ||
          craft.dynamics.status === 'LANDED' || craft.dynamics.status === 'CRASHED') return;
      input.clear();
      const program = RETURN_HOME_PROGRAM;
      recoveryModes.delete(craft.id);
      fcManager.installProgram(craft.id, program.id, program.name, program.language, program.code);
      fcManager.startProgram(craft, spacecraftManager, planet);
      if (clock.paused) clock.togglePause();
      clock.setTimeScale(2);
      spacecraftManager.pushEvent('RECOVERY GUIDANCE ENGAGED', 'Assessing current position, speed and remaining fuel. Esc for manual override.', 'info');
    },
    onSelectLaunchVehicle: (id) => {
      selectedLaunchVehicle = id;
      loadScenario('prelaunch', true);
    },
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
    onToggleWorkspace: () => {
      workspace.toggleWorkspace();
    },
    onManualOverride: triggerImmediateOverride,
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
  const lastFaultCount = new Map<string, number>();

  const frame = (now: number) => {
    if (renderFailed) return;
    requestAnimationFrame(frame);

    const realDt = Math.min(0.1, Math.max(0.0001, (now - lastFrameTime) / 1000));
    lastFrameTime = now;
    smoothedFps = smoothedFps * 0.92 + (1 / realDt) * 0.08;

    // Process UI/application hotkeys (Manual Override Esc works even while paused or editing!)
    const actions = input.consumeAppActions();
    if (actions.manualOverride) triggerImmediateOverride();
    if (actions.toggleWorkspace) workspace.toggleWorkspace();
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
      workspace.syncActiveSpacecraft(spacecraftManager.activeId);
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

    // Combine physical warp safety limit with running Flight Computer warp limits
    const simWarp = spacecraftManager.computeMaxSafeWarp();
    const fcWarp = fcManager.computeWarpRestriction();
    const maxWarp = Math.min(simWarp.maxWarp, fcWarp.maxWarp);
    const warpReason =
      fcWarp.maxWarp < simWarp.maxWarp ? fcWarp.reason : simWarp.reason ?? fcWarp.reason;

    const stepsExecuted = clock.advance(
      realDt,
      maxWarp,
      (stepDt) => {
        const flightInput = input.consumeFlightInput();
        planet.step(stepDt);
        fcManager.stepSimulationTime(stepDt, spacecraftManager, planet);

        spacecraftManager.stepAll(stepDt, flightInput, planet, (craft, isPlayerControlled) => {
          const manual = isPlayerControlled ? flightInput : NEUTRAL_FLIGHT_INPUT;
          return fcManager.getProgramControlInput(craft, manual) ?? NEUTRAL_FLIGHT_INPUT;
        });

        for (const craft of spacecraftManager.spacecraft) {
          const dyn = craft.dynamics;
          const isActive = craft.id === spacecraftManager.activeId;
          if (dyn.justIgnited) {
            if (isActive) audio.playIgnition();
            recorder.recordEvent(craft.id, planet.planetTimeS, dyn.missionElapsedTimeS, 'IGNITION', 'ignition');
          }
          if (dyn.justShutdown) {
            if (isActive) audio.playShutdown();
            recorder.recordEvent(craft.id, planet.planetTimeS, dyn.missionElapsedTimeS, 'SHUTDOWN', 'shutdown');
          }
          if (dyn.justLanded) {
            if (isActive) audio.playTouchdown();
            recorder.recordEvent(craft.id, planet.planetTimeS, dyn.missionElapsedTimeS, 'TOUCHDOWN', 'touchdown');
          }
          if (dyn.justCrashed) {
            if (isActive) audio.playCrash();
            recorder.recordEvent(craft.id, planet.planetTimeS, dyn.missionElapsedTimeS, 'IMPACT', 'fault');
          }

          const fc = fcManager.getComputer(craft.id);
          const prevFaults = lastFaultCount.get(craft.id) ?? 0;
          if (fc.faultHistory.length > prevFaults) {
            lastFaultCount.set(craft.id, fc.faultHistory.length);
            recorder.recordEvent(craft.id, planet.planetTimeS, dyn.missionElapsedTimeS, 'FC FAULT', 'fault');
            if (isActive) {
              spacecraftManager.pushEvent(
                'FLIGHT COMPUTER FAULT',
                fc.faultHistory[0]?.message ?? 'Safe fallback engaged.',
                'danger'
              );
            }
          }

          const snap = computeTelemetry(dyn, planet);
          recorder.stepRecord(stepDt, planet.planetTimeS, craft, snap, fc);
        }
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

    // Render frame (skip rendering when Full-Screen IDE covers the viewport to save GPU)
    if (workspace.mode !== 'FULL') {
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

    const activeFc = fcManager.getComputer(activeCraft.id);
    const coastalActive = activeCraft.id === coastalTourCraftId;
    const coastalPhase = String(activeFc.customVariables.phase ?? '');
    const adaptiveRecovery = activeFc.authority === 'PROGRAM' && activeFc.programId === RETURN_HOME_PROGRAM.id;
    const recoveryMode = adaptiveRecovery ? String(activeFc.customVariables.return_mode ?? 'ASSESS') : '';
    const returningHome = adaptiveRecovery || (coastalActive && activeFc.authority === 'PROGRAM' &&
      ['RETURN', 'LANDING', 'TOUCHDOWN', 'DONE'].includes(coastalPhase));
    if (adaptiveRecovery && recoveryModes.get(activeCraft.id) !== recoveryMode) {
      recoveryModes.set(activeCraft.id, recoveryMode);
      if (recoveryMode === 'HOME') spacecraftManager.pushEvent('HOME ROUTE SELECTED', 'Returning to LZ-1 with the remaining propellant.', 'success');
      if (recoveryMode === 'LOCAL_LANDING') spacecraftManager.pushEvent('LOCAL LANDING ATTEMPT', String(activeFc.customVariables.return_reason ?? 'Home exceeds the estimated fuel budget.'), 'info');
      if (recoveryMode === 'UNPOWERED') spacecraftManager.pushEvent('NO PROPELLANT REMAINING', 'Recovery guidance can stabilize attitude but cannot perform a powered landing.', 'info');
    }
    if (coastalActive && coastalPhase !== lastCoastalPhase) {
      lastCoastalPhase = coastalPhase;
      if (coastalPhase === 'HOLD') spacecraftManager.pushEvent('COASTAL WAYPOINT REACHED', 'Press RETURN HOME when ready. Automatic reserve protection remains active.', 'info');
      if (coastalPhase === 'RETURN' && activeFc.programId !== RETURN_HOME_PROGRAM.id) spacecraftManager.pushEvent('AUTOMATIC RETURN', 'Tour complete or fuel reserve reached. Returning to LZ-1.', 'info');
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
      clock.warpCapReason,
      {
        authority: activeFc.authority,
        workspaceOpen: workspace.mode !== 'CLOSED',
        scenarioBadge: currentScenario.isSandbox ? `SANDBOX` : null,
        canReturnHome: activeDyn.hasLiftedOff && activeDyn.hasLandingGear && activeDyn.config.maxThrustVacN > 0 && !['LANDED', 'CRASHED'].includes(activeDyn.status),
        returningHome: returningHome && !['LANDED', 'CRASHED'].includes(activeDyn.status),
        recoveryMode,
        recoveryReason: String(activeFc.customVariables.return_reason ?? ''),
      }
    );

    workspace.update(telemetry);
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

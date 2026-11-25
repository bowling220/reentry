import { FlightControlInput } from '../simulation/flightDynamics';

export interface AppActionEvents {
  cycleCamera: boolean;
  selectCameraIndex: number | null;
  togglePause: boolean;
  resetFlight: boolean;
  toggleHelp: boolean;
  toggleMap: boolean;
  toggleCinematicHud: boolean;
  stagePressed: boolean;
  cycleCraft: -1 | 0 | 1;
  warpStep: -1 | 0 | 1;
  toggleWorkspace: boolean;
  manualOverride: boolean;
}

/**
 * Keyboard input handler for manual rocket flight controls, staging, orbital map,
 * spacecraft switching, and simulation shortcuts.
 */
export class InputManager {
  private readonly keysDown = new Set<string>();

  // Rising-edge one-shot flight flags
  private igniteQueued = false;
  private toggleGearQueued = false;
  private toggleSasQueued = false;
  private cycleSasModeQueued = false;
  private setThrottleQueued: number | null = null;

  // Rising-edge app/UI action flags
  private cycleCameraQueued = false;
  private selectCameraIndexQueued: number | null = null;
  private togglePauseQueued = false;
  private resetFlightQueued = false;
  private toggleHelpQueued = false;
  private toggleMapQueued = false;
  private toggleCinematicHudQueued = false;
  private stageQueued = false;
  private cycleCraftQueued: -1 | 0 | 1 = 0;
  private warpStepQueued: -1 | 0 | 1 = 0;
  private toggleWorkspaceQueued = false;
  private manualOverrideQueued = false;

  constructor() {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;

    // Immediate Manual Override (Escape) ALWAYS works — even when typing in Monaco or inputs!
    if (code === 'Escape') {
      if (!this.keysDown.has('Escape')) {
        this.keysDown.add('Escape');
        this.manualOverrideQueued = true;
      }
      return;
    }

    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      target?.isContentEditable ||
      target?.closest?.('.monaco-editor')
    ) {
      return;
    }

    if (e.metaKey || e.altKey || (e.ctrlKey && code !== 'ControlLeft' && code !== 'ControlRight')) {
      return;
    }

    const wasDown = this.keysDown.has(code);
    this.keysDown.add(code);

    if (code === 'Space' || code.startsWith('Arrow')) {
      e.preventDefault();
    }

    if (wasDown) return;

    switch (code) {
      case 'Space':
        this.igniteQueued = true;
        break;
      case 'KeyX':
        this.setThrottleQueued = 0;
        break;
      case 'KeyZ':
        this.setThrottleQueued = 1;
        break;
      case 'KeyG':
        this.toggleGearQueued = true;
        break;
      case 'KeyT':
        this.toggleSasQueued = true;
        break;
      case 'KeyV':
        this.cycleSasModeQueued = true;
        break;
      case 'KeyB':
        this.stageQueued = true;
        break;
      case 'KeyM':
        this.toggleMapQueued = true;
        break;
      case 'KeyF':
        this.toggleWorkspaceQueued = true;
        break;
      case 'KeyU':
      case 'F2':
        e.preventDefault();
        this.toggleCinematicHudQueued = true;
        break;
      case 'BracketLeft':
        this.cycleCraftQueued = -1;
        break;
      case 'BracketRight':
        this.cycleCraftQueued = 1;
        break;
      case 'Period':
        this.warpStepQueued = 1;
        break;
      case 'Comma':
        this.warpStepQueued = -1;
        break;
      case 'KeyC':
        this.cycleCameraQueued = true;
        break;
      case 'KeyP':
        this.togglePauseQueued = true;
        break;
      case 'KeyR':
        this.resetFlightQueued = true;
        break;
      case 'KeyH':
      case 'Slash':
        this.toggleHelpQueued = true;
        break;
      case 'Digit1':
        this.selectCameraIndexQueued = 0;
        break;
      case 'Digit2':
        this.selectCameraIndexQueued = 1;
        break;
      case 'Digit3':
        this.selectCameraIndexQueued = 2;
        break;
      case 'Digit4':
        this.selectCameraIndexQueued = 3;
        break;
      case 'Digit5':
        this.selectCameraIndexQueued = 4;
        break;
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keysDown.delete(e.code);
  };

  private handleBlur = (): void => {
    this.clear();
  };

  public clear(): void {
    this.keysDown.clear();
    this.igniteQueued = false;
    this.toggleGearQueued = false;
    this.toggleSasQueued = false;
    this.cycleSasModeQueued = false;
    this.setThrottleQueued = null;
    this.cycleCameraQueued = false;
    this.selectCameraIndexQueued = null;
    this.togglePauseQueued = false;
    this.resetFlightQueued = false;
    this.toggleHelpQueued = false;
    this.toggleMapQueued = false;
    this.toggleCinematicHudQueued = false;
    this.stageQueued = false;
    this.cycleCraftQueued = 0;
    this.warpStepQueued = 0;
    this.toggleWorkspaceQueued = false;
    this.manualOverrideQueued = false;
  }

  public consumeMechanismToggles(): { gear: boolean; sas: boolean; cycleSasMode: boolean } {
    const toggles = {
      gear: this.toggleGearQueued,
      sas: this.toggleSasQueued,
      cycleSasMode: this.cycleSasModeQueued,
    };
    this.toggleGearQueued = false;
    this.toggleSasQueued = false;
    this.cycleSasModeQueued = false;
    return toggles;
  }

  public consumeFlightInput(): FlightControlInput {
    const pitch = (this.keysDown.has('KeyW') ? 1 : 0) - (this.keysDown.has('KeyS') ? 1 : 0);
    const yaw = (this.keysDown.has('KeyD') ? 1 : 0) - (this.keysDown.has('KeyA') ? 1 : 0);
    const roll = (this.keysDown.has('KeyE') ? 1 : 0) - (this.keysDown.has('KeyQ') ? 1 : 0);

    const throttleDelta =
      (this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight') ? 1 : 0) -
      (this.keysDown.has('ControlLeft') || this.keysDown.has('ControlRight') ? 1 : 0);

    const input: FlightControlInput = {
      pitch,
      yaw,
      roll,
      throttleDelta,
      setThrottle: this.setThrottleQueued,
      ignitePressed: this.igniteQueued,
      toggleGearPressed: this.toggleGearQueued,
      toggleSasPressed: this.toggleSasQueued,
      cycleSasModePressed: this.cycleSasModeQueued,
    };

    this.setThrottleQueued = null;
    this.igniteQueued = false;
    this.toggleGearQueued = false;
    this.toggleSasQueued = false;
    this.cycleSasModeQueued = false;

    return input;
  }

  public consumeAppActions(): AppActionEvents {
    const actions: AppActionEvents = {
      cycleCamera: this.cycleCameraQueued,
      selectCameraIndex: this.selectCameraIndexQueued,
      togglePause: this.togglePauseQueued,
      resetFlight: this.resetFlightQueued,
      toggleHelp: this.toggleHelpQueued,
      toggleMap: this.toggleMapQueued,
      toggleCinematicHud: this.toggleCinematicHudQueued,
      stagePressed: this.stageQueued,
      cycleCraft: this.cycleCraftQueued,
      warpStep: this.warpStepQueued,
      toggleWorkspace: this.toggleWorkspaceQueued,
      manualOverride: this.manualOverrideQueued,
    };

    this.cycleCameraQueued = false;
    this.selectCameraIndexQueued = null;
    this.togglePauseQueued = false;
    this.resetFlightQueued = false;
    this.toggleHelpQueued = false;
    this.toggleMapQueued = false;
    this.toggleCinematicHudQueued = false;
    this.stageQueued = false;
    this.cycleCraftQueued = 0;
    this.warpStepQueued = 0;
    this.toggleWorkspaceQueued = false;
    this.manualOverrideQueued = false;

    return actions;
  }
}

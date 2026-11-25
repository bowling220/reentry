import { CAMERA_MODE_LIST, CameraMode } from '../camera/cameraController';
import { ControlAuthority } from '../flightComputer/apiTypes';
import { TIME_WARP_LEVELS } from '../simulation/simulationLoop';
import { FlightEventNotice, SpacecraftManager } from '../simulation/spacecraftManager';
import { TelemetrySnapshot } from '../simulation/telemetry';
import { RendererBackendName } from '../rendering/rendererManager';
import { NavballRenderer } from './navball';
import { LAUNCH_VEHICLES, LaunchVehicleId } from '../config/launchVehicles';
import { AUTO_DEMOS } from '../flightComputer/demoPrograms';

export interface HudCallbacks {
  onLaunch: () => void;
  onStage: () => void;
  onTogglePause: () => void;
  onReset: () => void;
  onSelectLaunchVehicle: (id: LaunchVehicleId) => void;
  onStartDemo: (id: string) => void;
  onSelectCamera: (mode: CameraMode) => void;
  onSelectTimeWarp: (scale: number) => void;
  onToggleSasMode: () => void;
  onToggleGear: () => void;
  onToggleMap: () => void;
  onToggleWorkspace: () => void;
  onManualOverride: () => void;
  onSelectSpacecraft: (id: string) => void;
  onToggleMute: () => void;
  onVolumeChange: (vol: number) => void;
  onToggleSpaceAudio: () => void;
  onUiInteract?: () => void;
}

export interface HudFlightComputerState {
  authority: ControlAuthority;
  workspaceOpen: boolean;
  scenarioBadge: string | null;
}

/**
 * Phase 3 Aerospace Mission-Control HUD:
 * - Collapsible panels (Flight Telemetry, Orbital Telemetry, Propulsion & Staging, Spacecraft Tracker, Controls)
 * - Live Orbital Mechanics panel (AP, PE, Inclination, Eccentricity, Period, T-AP, T-PE, V_inertial, V_surface, Trajectory Class)
 * - Manual Staging Panel with safeguard status & per-stage propellant bars
 * - Multi-Spacecraft Tracking Panel with one-click switching
 * - Interactive 3D Orbital Map toggle & legend
 * - Audio controls (Mute, Volume, Vacuum/Cabin space audio)
 * - Flight event toast notifications & Hide-HUD cinematic mode
 */
export class FlightHud {
  private readonly root: HTMLElement;
  private readonly navball: NavballRenderer;
  private readonly callbacks: HudCallbacks;

  private helpOpen = false;
  private hudHidden = false;
  private els!: Record<string, HTMLElement>;
  private camButtons = new Map<CameraMode, HTMLButtonElement>();
  private warpButtons = new Map<number, HTMLButtonElement>();
  private lastTrackerKey = '';

  constructor(root: HTMLElement, callbacks: HudCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.root.innerHTML = this.buildMarkup();
    this.cacheElements();
    this.navball = new NavballRenderer(this.root.querySelector('#navball-canvas') as HTMLCanvasElement);
    this.bindEvents();
  }

  private buildMarkup(): string {
    const camBtnsHtml = CAMERA_MODE_LIST.map(
      (c, idx) =>
        `<button class="hud-btn cam-btn" data-cam="${c.id}" title="Shortcut: ${idx + 1}">${c.label}</button>`
    ).join('');

    const warpBtnsHtml = TIME_WARP_LEVELS.map(
      (w) => `<button class="hud-btn warp-btn" data-warp="${w}">${w}x</button>`
    ).join('');

    return `
      <!-- Floating Show-HUD Pill (visible only in Hide-HUD Cinematic Mode) -->
      <button class="hud-btn show-hud-pill hidden" id="btn-show-hud">SHOW HUD [U]</button>

      <section class="auto-demo-dialog hidden" id="auto-demo-dialog" role="dialog" aria-label="Automatic demo flights">
        <div class="auto-demo-title"><h2>AUTOMATIC DEMO FLIGHTS</h2><button class="hud-btn" id="btn-close-demos">CLOSE</button></div>
        <p>Pick a flight, sit back, and watch. Starting a demo resets the current flight and runs the included JavaScript template on a reusable REENTRY-9 booster.</p>
        ${AUTO_DEMOS.map(demo => `<article class="auto-demo-card"><div><h3>${demo.name}</h3><p>${demo.description}</p></div><button class="hud-btn primary" data-start-demo="${demo.id}">START ${demo.id === 'hop' ? 'QUICK HOP' : demo.id === 'landing' ? 'LANDING PREVIEW' : 'SPACE & RETURN'}</button></article>`).join('')}
        <p>Starts at 2× speed. Press <strong>Esc</strong> for manual override, or <strong>RESET</strong> to end the demo. The editable templates are in the Flight Computer's program library.</p>
      </section>

      <!-- Main HUD Wrapper (hidden cleanly in Cinematic Mode) -->
      <div class="hud-chrome" id="hud-chrome">
        <!-- Top Mission Control Status Strip -->
        <header class="hud-top-bar">
          <div class="hud-brand">
            <span class="brand-mark">REENTRY</span>
            <span class="brand-sub" id="val-craft-name">REENTRY-9 STACK</span>
            <span class="scenario-badge hidden" id="val-scenario-badge">SANDBOX</span>
          </div>

          <div class="hud-mission-center">
            <div class="status-pill" id="val-status-pill">
              <span class="status-dot" id="val-status-dot"></span>
              <span id="val-status">PRELAUNCH</span>
            </div>
            <div class="auth-pill" id="val-auth-pill" data-auth="assisted" title="Active Control Authority">
              <span id="val-auth">ASSISTED</span>
            </div>
            <button class="hud-btn override-pill hidden" id="btn-override" title="Immediate Manual Override (Esc)">OVERRIDE [ESC]</button>
            <div class="met-readout">
              <span class="lbl">MET</span>
              <span class="mono-val" id="val-met">T+00:00.0</span>
            </div>
            <div class="met-readout">
              <span class="lbl">SIM</span>
              <span class="mono-val" id="val-warp-effective">1x</span>
            </div>
            <button class="hud-btn map-toggle-btn" id="btn-map" title="Toggle 3D Orbital Map (M)">MAP [M]</button>
            <button class="hud-btn fc-toggle-btn" id="btn-fc" title="Toggle Flight Computer IDE (F)">FLIGHT COMP [F]</button>
            <button class="hud-btn" id="btn-demos">AUTO DEMOS</button>
          </div>

          <div class="hud-sys-right">
            <div class="audio-controls">
              <button class="hud-btn compact" id="btn-mute" title="Mute / Unmute Audio">SND: ON</button>
              <input class="vol-slider" id="vol-slider" type="range" min="0" max="100" value="65" title="Master Volume" />
              <button class="hud-btn compact active" id="btn-space-audio" title="Toggle Onboard Space Audio vs Real Vacuum Silence">CABIN</button>
            </div>
            <span class="sys-tag" id="val-backend">WebGPU</span>
            <span class="sys-tag"><span id="val-fps">60</span> FPS</span>
            <button class="hud-btn compact" id="btn-help" title="Toggle Controls Reference (H)">KEYS</button>
            <button class="hud-btn compact" id="btn-hide-hud" title="Hide HUD Cinematic Mode (U)">HIDE</button>
          </div>
        </header>

        <!-- Orbital Map Legend Strip (only shown in Map View) -->
        <div class="map-legend hidden" id="map-legend">
          <span class="legend-item"><span class="swatch cyan"></span>Predicted Orbit</span>
          <span class="legend-item"><span class="swatch amber"></span>Flight History</span>
          <span class="legend-item"><span class="swatch teal"></span>Ground Track</span>
          <span class="legend-sep">|</span>
          <span class="legend-hint">Drag: Rotate Earth &bull; Scroll: Zoom &bull; Click Label: Focus Craft &bull; [M] Exit Map</span>
        </div>

        <!-- Flight Event Notification Toast Stack -->
        <div class="toast-stack" id="toast-stack"></div>

        <!-- Left Column: Flight Telemetry + Orbital Telemetry (Collapsible) -->
        <div class="hud-col hud-col-left">
          <section class="hud-panel" data-panel="flight">
            <div class="panel-header">
              <span class="panel-title">FLIGHT TELEMETRY</span>
              <button class="collapse-btn" data-toggle="flight" title="Collapse/Expand">&minus;</button>
            </div>
            <div class="panel-body" id="body-flight">
              <div class="telem-grid">
                <div class="telem-cell">
                  <span class="lbl">ALT ASL</span>
                  <span class="val" id="val-alt-asl">0.0 m</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">ALT AGL</span>
                  <span class="val" id="val-alt-agl">0.0 m</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">VERT VEL</span>
                  <span class="val" id="val-vel-v">0.0 m/s</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">HORIZ VEL</span>
                  <span class="val" id="val-vel-h">0.0 m/s</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">SURF VEL</span>
                  <span class="val" id="val-vel-tot">0.0 m/s</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">ACCEL / G</span>
                  <span class="val" id="val-accel">9.8 m/s² (1.0G)</span>
                </div>
              </div>
              <div class="panel-divider"></div>
              <div class="telem-grid">
                <div class="telem-cell">
                  <span class="lbl">LAT / LON</span>
                  <span class="val small" id="val-latlon">28.562°N 80.577°W</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">RANGE PAD</span>
                  <span class="val" id="val-range">0.0 m</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">AIR DENSITY</span>
                  <span class="val" id="val-rho">1.225 kg/m³</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">GRAVITY</span>
                  <span class="val" id="val-grav">9.820 m/s²</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">PITCH / YAW / ROLL</span>
                  <span class="val small" id="val-pyr">+90° / 000° / +0°</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">MACH / Q</span>
                  <span class="val small" id="val-mach">M0.00 / 0.0 kPa</span>
                </div>
              </div>
            </div>
          </section>

          <section class="hud-panel" data-panel="orbital">
            <div class="panel-header">
              <span class="panel-title">ORBITAL TELEMETRY</span>
              <span class="traj-badge" id="val-traj-class">PRELAUNCH</span>
              <button class="collapse-btn" data-toggle="orbital" title="Collapse/Expand">&minus;</button>
            </div>
            <div class="panel-body" id="body-orbital">
              <div class="telem-grid">
                <div class="telem-cell">
                  <span class="lbl">APOAPSIS (AP)</span>
                  <span class="val" id="val-ap">—</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">PERIAPSIS (PE)</span>
                  <span class="val" id="val-pe">—</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">TIME TO AP</span>
                  <span class="val" id="val-tap">—</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">TIME TO PE</span>
                  <span class="val" id="val-tpe">—</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">INERTIAL VEL</span>
                  <span class="val" id="val-vel-iner">408.0 m/s</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">PERIOD</span>
                  <span class="val" id="val-period">—</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">INCLINATION</span>
                  <span class="val" id="val-inc">—</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">ECCENTRICITY</span>
                  <span class="val" id="val-ecc">—</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <!-- Right Column: Propulsion & Staging + Spacecraft Tracker + Collapsible Controls -->
        <div class="hud-col hud-col-right">
          <section class="hud-panel" data-panel="propulsion">
            <div class="panel-header">
              <span class="panel-title">PROPULSION &amp; STAGING</span>
              <span class="engine-badge" id="val-engine">IDLE</span>
              <button class="collapse-btn" data-toggle="propulsion" title="Collapse/Expand">&minus;</button>
            </div>
            <div class="panel-body" id="body-propulsion">
              <div class="bar-group">
                <div class="bar-label">
                  <span>THROTTLE</span>
                  <span class="mono-val" id="val-throttle">0%</span>
                </div>
                <div class="bar-track">
                  <div class="bar-fill throttle" id="bar-throttle" style="width: 0%"></div>
                </div>
              </div>

              <div class="bar-group">
                <div class="bar-label">
                  <span>ACTIVE STAGE FUEL</span>
                  <span class="mono-val" id="val-fuel">100.0%</span>
                </div>
                <div class="bar-track">
                  <div class="bar-fill fuel" id="bar-fuel" style="width: 100%"></div>
                </div>
              </div>

              <div class="telem-grid compact-grid">
                <div class="telem-cell">
                  <span class="lbl">THRUST</span>
                  <span class="val" id="val-thrust">0 kN</span>
                </div>
                <div class="telem-cell">
                  <span class="lbl">MASS</span>
                  <span class="val" id="val-mass">550.0 t</span>
                </div>
              </div>

              <!-- Attached Stage Propellant Indicators -->
              <div class="stage-stack" id="stage-stack"></div>

              <button class="hud-btn stage-btn" id="btn-stage" title="Manual Stage Separation (B)">
                STAGE [B]: SEP STAGE 1
              </button>

              <div class="toggle-row">
                <button class="hud-btn toggle active" id="btn-sas" title="Cycle SAS Mode (V) / Toggle (T)">SAS: HOLD</button>
                <button class="hud-btn toggle" id="btn-gear" title="Deploy/Retract Landing Legs (G)">GEAR: UP</button>
              </div>
            </div>
          </section>

          <section class="hud-panel" data-panel="tracker">
            <div class="panel-header">
              <span class="panel-title">SPACECRAFT TRACKER (<span id="val-craft-count">1</span>)</span>
              <button class="collapse-btn" data-toggle="tracker" title="Collapse/Expand">&minus;</button>
            </div>
            <div class="panel-body" id="body-tracker">
              <div class="tracker-list" id="tracker-list"></div>
            </div>
          </section>

          <section class="hud-panel hidden" id="keys-card">
            <div class="panel-header">
              <span class="panel-title">FLIGHT CONTROLS</span>
              <button class="collapse-btn" id="btn-close-keys" title="Close">&times;</button>
            </div>
            <div class="keys-list">
              <div><kbd>SPACE</kbd> Ignite / Launch</div>
              <div><kbd>F</kbd> Flight Computer IDE</div>
              <div><kbd>ESC</kbd> Immediate Manual Override</div>
              <div><kbd>B</kbd> Stage Separation / Deploy</div>
              <div><kbd>M</kbd> 3D Orbital Map</div>
              <div><kbd>[</kbd> <kbd>]</kbd> Switch Spacecraft</div>
              <div><kbd>SHIFT</kbd> / <kbd>CTRL</kbd> Throttle &plusmn;</div>
              <div><kbd>Z</kbd> / <kbd>X</kbd> Max / Cut Throttle</div>
              <div><kbd>W</kbd><kbd>S</kbd> <kbd>A</kbd><kbd>D</kbd> Pitch / Yaw &nbsp;<kbd>Q</kbd><kbd>E</kbd> Roll</div>
              <div><kbd>T</kbd> SAS On/Off &nbsp;<kbd>V</kbd> SAS Mode</div>
              <div><kbd>G</kbd> Landing Legs &nbsp;<kbd>C</kbd>/<kbd>1-5</kbd> Cam</div>
              <div><kbd>,</kbd> <kbd>.</kbd> Time Warp &nbsp;<kbd>P</kbd> Pause &nbsp;<kbd>R</kbd> Reset</div>
              <div><kbd>U</kbd> Hide HUD &nbsp;<kbd>H</kbd> Controls</div>
            </div>
          </section>
        </div>

        <!-- Bottom Center: Navball + Flight Control Deck -->
        <div class="hud-bottom-cluster">
          <div class="navball-wrap">
            <canvas id="navball-canvas"></canvas>
          </div>

          <div class="control-deck">
            <div class="deck-row">
              <label class="deck-lbl" for="launch-vehicle">ROCKET</label>
              <select id="launch-vehicle" class="launch-vehicle" aria-label="Launch vehicle" title="Reset flight to choose another rocket">
                ${LAUNCH_VEHICLES.map(v => `<option value="${v.id}">${v.name}</option>`).join('')}
              </select>
            </div>
            <div class="deck-row">
              <button class="hud-btn primary" id="btn-launch">IGNITE / LAUNCH</button>
              <button class="hud-btn" id="btn-pause">PAUSE</button>
              <button class="hud-btn danger" id="btn-reset">RESET</button>
            </div>
            <div class="deck-row">
              <span class="deck-lbl">CAM</span>
              <div class="btn-group">${camBtnsHtml}</div>
            </div>
            <div class="deck-row">
              <span class="deck-lbl">WARP</span>
              <div class="btn-group">${warpBtnsHtml}</div>
            </div>
          </div>
        </div>

        <!-- Crash / Landed Non-Blocking Banner -->
        <div class="flight-banner hidden" id="flight-banner">
          <div class="banner-title" id="banner-title">VEHICLE TOUCHDOWN</div>
          <div class="banner-sub" id="banner-sub">Press R or click RESET to relaunch from Cape Canaveral</div>
        </div>
      </div>
    `;
  }

  private cacheElements(): void {
    const q = (id: string) => this.root.querySelector(`#${id}`) as HTMLElement;
    this.els = {
      chrome: q('hud-chrome'),
      btnShowHud: q('btn-show-hud'),
      btnHideHud: q('btn-hide-hud'),
      craftName: q('val-craft-name'),
      scenarioBadge: q('val-scenario-badge'),
      statusPill: q('val-status-pill'),
      statusDot: q('val-status-dot'),
      status: q('val-status'),
      authPill: q('val-auth-pill'),
      authVal: q('val-auth'),
      btnOverride: q('btn-override'),
      met: q('val-met'),
      warpEff: q('val-warp-effective'),
      btnMap: q('btn-map'),
      btnFc: q('btn-fc'),
      mapLegend: q('map-legend'),
      toastStack: q('toast-stack'),
      btnMute: q('btn-mute'),
      volSlider: q('vol-slider'),
      btnSpaceAudio: q('btn-space-audio'),
      backend: q('val-backend'),
      fps: q('val-fps'),
      altAsl: q('val-alt-asl'),
      altAgl: q('val-alt-agl'),
      velV: q('val-vel-v'),
      velH: q('val-vel-h'),
      velTot: q('val-vel-tot'),
      accel: q('val-accel'),
      latlon: q('val-latlon'),
      range: q('val-range'),
      rho: q('val-rho'),
      grav: q('val-grav'),
      pyr: q('val-pyr'),
      mach: q('val-mach'),
      trajClass: q('val-traj-class'),
      ap: q('val-ap'),
      pe: q('val-pe'),
      tap: q('val-tap'),
      tpe: q('val-tpe'),
      velIner: q('val-vel-iner'),
      period: q('val-period'),
      inc: q('val-inc'),
      ecc: q('val-ecc'),
      engine: q('val-engine'),
      throttle: q('val-throttle'),
      barThrottle: q('bar-throttle'),
      fuel: q('val-fuel'),
      barFuel: q('bar-fuel'),
      thrust: q('val-thrust'),
      mass: q('val-mass'),
      stageStack: q('stage-stack'),
      btnStage: q('btn-stage'),
      btnLaunch: q('btn-launch'),
      btnPause: q('btn-pause'),
      btnReset: q('btn-reset'),
      btnSas: q('btn-sas'),
      btnGear: q('btn-gear'),
      btnHelp: q('btn-help'),
      btnCloseKeys: q('btn-close-keys'),
      keysCard: q('keys-card'),
      craftCount: q('val-craft-count'),
      trackerList: q('tracker-list'),
      banner: q('flight-banner'),
      bannerTitle: q('banner-title'),
      bannerSub: q('banner-sub'),
    };

    this.root.querySelectorAll<HTMLButtonElement>('.cam-btn').forEach((btn) => {
      this.camButtons.set(btn.dataset.cam as CameraMode, btn);
    });
    this.root.querySelectorAll<HTMLButtonElement>('.warp-btn').forEach((btn) => {
      this.warpButtons.set(Number(btn.dataset.warp), btn);
    });
  }

  private bindEvents(): void {
    const demos = this.root.querySelector<HTMLElement>('#auto-demo-dialog')!;
    this.root.querySelector('#btn-demos')!.addEventListener('click', () => demos.classList.toggle('hidden'));
    this.root.querySelector('#btn-close-demos')!.addEventListener('click', () => demos.classList.add('hidden'));
    this.root.querySelectorAll<HTMLButtonElement>('[data-start-demo]').forEach(button => {
      button.addEventListener('click', () => {
        demos.classList.add('hidden');
        this.callbacks.onStartDemo(button.dataset.startDemo!);
      });
    });
    this.root.querySelector<HTMLSelectElement>('#launch-vehicle')!.addEventListener('change', (event) => {
      const id = (event.target as HTMLSelectElement).value;
      if (id === 'falcon9' || id === 'saturn-v') this.callbacks.onSelectLaunchVehicle(id);
      (event.target as HTMLSelectElement).blur();
    });
    const click = (fn: () => void) => () => {
      this.callbacks.onUiInteract?.();
      fn();
    };

    this.els.btnLaunch.addEventListener('click', click(() => this.callbacks.onLaunch()));
    this.els.btnStage.addEventListener('click', click(() => this.callbacks.onStage()));
    this.els.btnPause.addEventListener('click', click(() => this.callbacks.onTogglePause()));
    this.els.btnReset.addEventListener('click', click(() => this.callbacks.onReset()));
    this.els.btnSas.addEventListener('click', click(() => this.callbacks.onToggleSasMode()));
    this.els.btnGear.addEventListener('click', click(() => this.callbacks.onToggleGear()));
    this.els.btnMap.addEventListener('click', click(() => this.callbacks.onToggleMap()));
    this.els.btnFc.addEventListener('click', click(() => this.callbacks.onToggleWorkspace()));
    this.els.btnOverride.addEventListener('click', click(() => this.callbacks.onManualOverride()));
    this.els.btnHelp.addEventListener('click', click(() => this.toggleHelp()));
    this.els.btnCloseKeys.addEventListener('click', click(() => this.toggleHelp()));
    this.els.btnHideHud.addEventListener('click', click(() => this.toggleCinematicHud()));
    this.els.btnShowHud.addEventListener('click', click(() => this.toggleCinematicHud()));
    this.els.btnMute.addEventListener('click', click(() => this.callbacks.onToggleMute()));
    this.els.btnSpaceAudio.addEventListener('click', click(() => this.callbacks.onToggleSpaceAudio()));

    (this.els.volSlider as HTMLInputElement).addEventListener('input', (e) => {
      const val = Number((e.target as HTMLInputElement).value) / 100;
      this.callbacks.onVolumeChange(val);
    });

    this.camButtons.forEach((btn, mode) => {
      btn.addEventListener('click', click(() => this.callbacks.onSelectCamera(mode)));
    });
    this.warpButtons.forEach((btn, scale) => {
      btn.addEventListener('click', click(() => this.callbacks.onSelectTimeWarp(scale)));
    });

    // Collapsible panel buttons
    this.root.querySelectorAll<HTMLButtonElement>('.collapse-btn[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.toggle!;
        const body = this.root.querySelector(`#body-${key}`);
        if (!body) return;
        const collapsed = body.classList.toggle('hidden');
        btn.textContent = collapsed ? '+' : '−';
      });
    });
  }

  public toggleHelp(): void {
    this.helpOpen = !this.helpOpen;
    this.els.keysCard.classList.toggle('hidden', !this.helpOpen);
    this.els.btnHelp.classList.toggle('active', this.helpOpen);
  }

  public toggleCinematicHud(): void {
    this.hudHidden = !this.hudHidden;
    this.els.chrome.classList.toggle('hidden', this.hudHidden);
    this.els.btnShowHud.classList.toggle('hidden', !this.hudHidden);
  }

  public setBackendName(name: RendererBackendName): void {
    this.els.backend.textContent = name;
  }

  public setAudioUiState(muted: boolean, onboardSpaceAudio: boolean): void {
    this.els.btnMute.textContent = muted ? 'SND: OFF' : 'SND: ON';
    this.els.btnMute.classList.toggle('active', !muted);
    this.els.btnSpaceAudio.textContent = onboardSpaceAudio ? 'CABIN' : 'VAC';
    this.els.btnSpaceAudio.classList.toggle('active', onboardSpaceAudio);
  }

  public pushToast(notice: FlightEventNotice): void {
    const el = document.createElement('div');
    el.className = `toast-item toast-${notice.severity}`;
    el.innerHTML = `<div class="toast-title">${notice.title}</div><div class="toast-detail">${notice.detail}</div>`;
    this.els.toastStack.appendChild(el);
    setTimeout(() => {
      el.classList.add('fade-out');
      setTimeout(() => el.remove(), 350);
    }, 4400);
  }

  public update(
    t: TelemetrySnapshot,
    manager: SpacecraftManager,
    fps: number,
    activeCamera: CameraMode,
    inMapView: boolean,
    paused: boolean,
    requestedWarp: number,
    effectiveWarp: number,
    warpCapReason: string | null,
    fcState?: HudFlightComputerState
  ): void {
    this.navball.render(t);

    const activeCraft = manager.activeSpacecraft;
    const vehicleSelect = this.root.querySelector<HTMLSelectElement>('#launch-vehicle')!;
    vehicleSelect.value = manager.launchVehicleId;
    vehicleSelect.disabled = activeCraft.dynamics.status !== 'PRELAUNCH';
    this.els.craftName.textContent = activeCraft.name.toUpperCase();

    if (fcState) {
      this.els.authVal.textContent = fcState.authority;
      this.els.authPill.dataset.auth = fcState.authority.toLowerCase();
      const showOverride = fcState.authority === 'PROGRAM' || fcState.authority === 'FAULT';
      this.els.btnOverride.classList.toggle('hidden', !showOverride);
      this.els.btnFc.classList.toggle('active', fcState.workspaceOpen);
      if (fcState.scenarioBadge) {
        this.els.scenarioBadge.textContent = fcState.scenarioBadge;
        this.els.scenarioBadge.classList.remove('hidden');
      } else {
        this.els.scenarioBadge.classList.add('hidden');
      }
    }

    // Status pill
    this.els.status.textContent = paused ? `${t.flightStatus} [PAUSED]` : t.flightStatus;
    this.els.statusPill.dataset.state = t.flightStatus.toLowerCase();

    // MET, FPS & Requested vs Effective Warp
    this.els.met.textContent = formatMET(t.missionElapsedTimeS);
    this.els.fps.textContent = `${Math.round(fps)}`;
    if (paused) {
      this.els.warpEff.textContent = 'PAUSED';
    } else if (effectiveWarp < requestedWarp) {
      this.els.warpEff.textContent = `${effectiveWarp}x / ${requestedWarp}x (${warpCapReason ?? 'CAP'})`;
    } else {
      this.els.warpEff.textContent = `${effectiveWarp}x`;
    }

    // Orbital Map button & legend
    this.els.btnMap.classList.toggle('active', inMapView);
    this.els.btnMap.textContent = inMapView ? 'EXIT MAP [M]' : 'MAP [M]';
    this.els.mapLegend.classList.toggle('hidden', !inMapView);

    // Flight telemetry numbers
    this.els.altAsl.textContent = formatDistance(t.altitudeASLM);
    this.els.altAgl.textContent = formatDistance(t.altitudeAGLM);
    this.els.velV.textContent = `${t.verticalVelocityMs >= 0 ? '+' : ''}${formatSpeed(t.verticalVelocityMs)}`;
    this.els.velH.textContent = formatSpeed(t.horizontalVelocityMs);
    this.els.velTot.textContent = formatSpeed(t.totalVelocityMs);
    this.els.accel.textContent = `${t.accelerationMs2.toFixed(1)} m/s² (${t.gForce.toFixed(1)}G)`;

    const latHem = t.latitudeDeg >= 0 ? 'N' : 'S';
    const lonHem = t.longitudeDeg >= 0 ? 'E' : 'W';
    this.els.latlon.textContent = `${Math.abs(t.latitudeDeg).toFixed(3)}°${latHem} ${Math.abs(t.longitudeDeg).toFixed(3)}°${lonHem}`;
    this.els.range.textContent = formatDistance(t.distanceFromLaunchM);
    this.els.rho.textContent =
      t.atmosphericDensityKgM3 < 0.0001
        ? 'VACUUM'
        : `${t.atmosphericDensityKgM3.toFixed(t.atmosphericDensityKgM3 < 0.01 ? 4 : 3)} kg/m³`;
    this.els.grav.textContent = `${t.gravityMs2.toFixed(3)} m/s²`;

    const pStr = `${t.pitchDeg >= 0 ? '+' : ''}${Math.round(t.pitchDeg)}°`;
    const yStr = `${Math.round(t.yawHeadingDeg).toString().padStart(3, '0')}°`;
    const rStr = `${t.rollDeg >= 0 ? '+' : ''}${Math.round(t.rollDeg)}°`;
    this.els.pyr.textContent = `${pStr} / ${yStr} / ${rStr}`;
    this.els.mach.textContent = `M${t.machNumber.toFixed(2)} / ${t.dynamicPressureKPa.toFixed(1)} kPa`;

    // Orbital telemetry panel (never display NaN/invalid values!)
    const orb = t.orbital;
    this.els.trajClass.textContent = orb.classification;
    this.els.trajClass.dataset.state = orb.classification.toLowerCase();
    this.els.velIner.textContent = formatSpeed(t.inertialVelocityMs);

    if (!orb.valid) {
      this.els.ap.textContent = '—';
      this.els.pe.textContent = '—';
      this.els.tap.textContent = '—';
      this.els.tpe.textContent = '—';
      this.els.period.textContent = '—';
      this.els.inc.textContent = '—';
      this.els.ecc.textContent = '—';
    } else {
      this.els.ap.textContent =
        orb.classification === 'ESCAPE'
          ? 'ESCAPE'
          : orb.apoapsisAltM !== null
            ? formatDistance(orb.apoapsisAltM)
            : '—';
      this.els.pe.textContent =
        orb.periapsisAltM !== null ? formatDistance(orb.periapsisAltM) : '—';
      this.els.tap.textContent =
        orb.timeToApoapsisS !== null ? formatDuration(orb.timeToApoapsisS) : '—';
      this.els.tpe.textContent =
        orb.timeToPeriapsisS !== null ? formatDuration(orb.timeToPeriapsisS) : '—';
      this.els.period.textContent =
        orb.periodS !== null ? formatDuration(orb.periodS) : '—';
      this.els.inc.textContent =
        orb.inclinationDeg !== null ? `${orb.inclinationDeg.toFixed(2)}°` : '—';
      this.els.ecc.textContent =
        orb.eccentricity !== null ? orb.eccentricity.toFixed(4) : '—';
    }

    // Propulsion gauges
    let engState = 'IDLE';
    if (activeCraft.dynamics.config.maxThrustVacN <= 0) engState = 'NO ENG';
    else if (t.fuelKg <= 0.1) engState = 'DEPLETED';
    else if (t.engineIgnited && t.throttlePercent > 1) engState = 'ACTIVE';
    else if (t.flightStatus === 'CRASHED') engState = 'OFFLINE';

    this.els.engine.textContent = engState;
    this.els.engine.dataset.state = engState.toLowerCase().replace(/\s+/g, '');

    this.els.throttle.textContent = `${Math.round(t.throttlePercent)}%`;
    this.els.barThrottle.style.width = `${Math.min(100, Math.max(0, t.throttlePercent))}%`;

    this.els.fuel.textContent =
      activeCraft.dynamics.config.propellantMassKg > 0 ? `${t.fuelPercent.toFixed(1)}%` : 'N/A';
    this.els.barFuel.style.width = `${Math.min(100, Math.max(0, t.fuelPercent))}%`;
    this.els.barFuel.classList.toggle('low', t.fuelPercent < 15 && activeCraft.dynamics.config.propellantMassKg > 0);

    this.els.thrust.textContent =
      t.thrustKN >= 10
        ? `${Math.round(t.thrustKN).toLocaleString()} kN`
        : `${t.thrustKN.toFixed(2)} kN`;
    this.els.mass.textContent = `${(t.totalMassKg / 1000).toFixed(2)} t`;

    // Stage fuel summary chips
    const stages = manager.getStageSummaries(activeCraft);
    this.els.stageStack.innerHTML = stages
      .map(
        (s) => `
        <div class="stage-chip ${s.active ? 'active' : ''}">
          <span>${s.label}</span>
          <span class="mono-val">${s.label === 'FAIRING' ? 'ATT' : `${Math.round(s.percent)}%`}</span>
        </div>`
      )
      .join('');

    // Manual Stage button with safeguard
    const stageAction = manager.getNextStageAction(activeCraft);
    const stageBtn = this.els.btnStage as HTMLButtonElement;
    stageBtn.disabled = !stageAction.available;
    stageBtn.textContent = stageAction.available
      ? `STAGE [B]: ${stageAction.label}`
      : stageAction.blockedReason
        ? `STAGE [B]: ${stageAction.label}`
        : 'STAGING COMPLETE';
    stageBtn.classList.toggle('ready', stageAction.available);

    // Mechanism & mode buttons
    this.els.btnPause.textContent = paused ? 'RESUME' : 'PAUSE';
    this.els.btnPause.classList.toggle('active', paused);

    const sasLabel = t.sasMode === 'RETROGRADE' ? 'RETRO' : t.sasMode === 'VERTICAL' ? 'VERT' : t.sasMode;
    this.els.btnSas.textContent = `SAS: ${sasLabel}`;
    this.els.btnSas.classList.toggle('active', t.sasEnabled);

    const gearBtn = this.els.btnGear as HTMLButtonElement;
    gearBtn.disabled = !t.hasLandingGear;
    gearBtn.textContent = t.hasLandingGear ? `GEAR: ${t.gearDeployed ? 'DOWN' : 'UP'}` : 'GEAR: N/A';
    gearBtn.classList.toggle('active', t.hasLandingGear && t.gearDeployed);

    this.els.btnLaunch.textContent = t.engineIgnited ? 'MAX THROTTLE' : 'IGNITE / LAUNCH';

    this.camButtons.forEach((btn, mode) => {
      btn.classList.toggle('active', !inMapView && mode === activeCamera);
    });
    this.warpButtons.forEach((btn, scale) => {
      btn.classList.toggle('active', scale === requestedWarp);
    });

    // Spacecraft Tracker panel (re-render efficiently when values/selection change)
    this.els.craftCount.textContent = `${manager.spacecraft.length}`;
    this.renderSpacecraftTracker(manager);

    // End-of-flight status banner
    if (t.flightStatus === 'CRASHED') {
      this.els.banner.classList.remove('hidden');
      this.els.banner.dataset.type = 'crash';
      this.els.bannerTitle.textContent = `${activeCraft.name.toUpperCase()} — DESTROYED`;
      this.els.bannerSub.textContent =
        manager.spacecraft.length > 1
          ? 'Switch to another spacecraft in the Tracker or press R to reset'
          : 'Press R or click RESET to return to Cape Canaveral SLC-40';
    } else if (t.flightStatus === 'LANDED') {
      this.els.banner.classList.remove('hidden');
      this.els.banner.dataset.type = 'landed';
      this.els.bannerTitle.textContent = `${activeCraft.name.toUpperCase()} — LANDED SAFELY`;
      this.els.bannerSub.textContent = `Range from Pad: ${formatDistance(t.distanceFromLaunchM)} • Switch craft or press R to reset`;
    } else {
      this.els.banner.classList.add('hidden');
    }
  }

  private renderSpacecraftTracker(manager: SpacecraftManager): void {
    const keyParts = manager.spacecraft.map((c) => {
      const alt = Math.round(c.dynamics.getAltitudeASL() / 100);
      const spd = Math.round(
        Math.hypot(c.dynamics.velECEF.x, c.dynamics.velECEF.y, c.dynamics.velECEF.z)
      );
      return `${c.id}:${c.id === manager.activeId ? 1 : 0}:${c.name}:${alt}:${spd}:${c.dynamics.status}`;
    });
    const key = keyParts.join('|');
    if (key === this.lastTrackerKey) return;
    this.lastTrackerKey = key;

    this.els.trackerList.innerHTML = '';
    for (const c of manager.spacecraft) {
      const isActive = c.id === manager.activeId;
      const alt = c.dynamics.getAltitudeASL();
      const spd = Math.hypot(c.dynamics.velECEF.x, c.dynamics.velECEF.y, c.dynamics.velECEF.z);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `tracker-row${isActive ? ' active' : ''}`;
      row.innerHTML = `
        <div class="tracker-top">
          <span class="tracker-name">${c.name}</span>
          <span class="tracker-st st-${c.dynamics.status.toLowerCase()}">${c.dynamics.status}</span>
        </div>
        <div class="tracker-meta">
          <span>ALT ${formatDistance(alt)}</span>
          <span>VEL ${formatSpeed(spd)}</span>
        </div>
      `;
      row.addEventListener('click', () => {
        this.callbacks.onUiInteract?.();
        this.callbacks.onSelectSpacecraft(c.id);
      });
      this.els.trackerList.appendChild(row);
    }
  }
}

function formatDistance(meters: number): string {
  const abs = Math.abs(meters);
  if (abs >= 1_000_000) return `${(meters / 1000).toFixed(0)} km`;
  if (abs >= 10_000) return `${(meters / 1000).toFixed(2)} km`;
  if (abs >= 1_000) return `${(meters / 1000).toFixed(3)} km`;
  return `${meters.toFixed(1)} m`;
}

function formatSpeed(ms: number): string {
  if (Math.abs(ms) >= 1000) return `${(ms / 1000).toFixed(2)} km/s`;
  return `${ms.toFixed(1)} m/s`;
}

function formatMET(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hrs > 0) {
    return `T+${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${Math.floor(secs).toString().padStart(2, '0')}`;
  }
  return `T+${mins.toString().padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds >= 3600) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

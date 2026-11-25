import type * as Monaco from 'monaco-editor';
import { ProgramLanguage } from '../flightComputer/apiTypes';
import { API_DOCUMENTATION_HTML, StoredProgram } from '../flightComputer/examplePrograms';
import { FlightComputerManager } from '../flightComputer/flightComputerManager';
import { FlightDataRecorder } from '../flightComputer/flightRecorder';
import { ProgramLibrary } from '../flightComputer/programLibrary';
import { PlanetSimulation } from '../simulation/planetSimulation';
import { FLIGHT_SCENARIOS, ScenarioId } from '../simulation/scenarios';
import { SpacecraftManager } from '../simulation/spacecraftManager';
import { TelemetrySnapshot } from '../simulation/telemetry';
import { loadMonaco } from './monacoSetup';
import { TelemetryGraphView } from './telemetryGraphs';

export type WorkspaceMode = 'CLOSED' | 'SPLIT' | 'FULL';
type BottomTab = 'console' | 'debug' | 'graphs' | 'scenarios' | 'docs';

export interface WorkspaceCallbacks {
  onModeChange: (mode: WorkspaceMode) => void;
  onSplitResize?: (widthPx: number) => void;
  onLoadScenario: (id: ScenarioId, keepInstalledProgram: boolean) => void;
  onSelectSpacecraft: (id: string) => void;
  onUiClick?: () => void;
}

/**
 * Aerospace Engineering Workspace IDE featuring Monaco Editor, File Explorer,
 * Tabs, Resizable Split/Full Modes, Program Execution & Debugging Tools,
 * Live Telemetry Inspector, Zoomable Telemetry Graphs, 7 Testing Scenarios,
 * and Built-In REENTRY Flight API v1.0.0 Documentation.
 */
export class EngineeringWorkspace {
  public mode: WorkspaceMode = 'CLOSED';
  public currentScenarioId: ScenarioId = 'prelaunch';

  private readonly root: HTMLElement;
  private readonly library: ProgramLibrary;
  private readonly fcManager: FlightComputerManager;
  private readonly recorder: FlightDataRecorder;
  private readonly spacecraftManager: SpacecraftManager;
  private readonly planet: PlanetSimulation;
  private readonly callbacks: WorkspaceCallbacks;

  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private editorInitializing = false;
  private graphs!: TelemetryGraphView;

  private openTabIds: string[] = [];
  private activeProgramId: string | null = null;
  private dirtyPrograms = new Map<string, string>();
  private languageFilter: 'all' | ProgramLanguage = 'all';
  private activeBottomTab: BottomTab = 'console';
  private selectedCraftId: string;
  private splitWidthPx = Math.min(720, Math.round(window.innerWidth * 0.52));
  private bottomHeightPx = 225;

  private lastConsoleLen = -1;
  private lastCraftListSig = '';
  private lastUiTick = 0;

  private els!: Record<string, HTMLElement>;

  constructor(
    container: HTMLElement,
    library: ProgramLibrary,
    fcManager: FlightComputerManager,
    recorder: FlightDataRecorder,
    spacecraftManager: SpacecraftManager,
    planet: PlanetSimulation,
    callbacks: WorkspaceCallbacks
  ) {
    this.root = container;
    this.library = library;
    this.fcManager = fcManager;
    this.recorder = recorder;
    this.spacecraftManager = spacecraftManager;
    this.planet = planet;
    this.callbacks = callbacks;
    this.selectedCraftId = spacecraftManager.activeId;

    this.root.innerHTML = this.buildMarkup();
    this.cacheElements();
    this.graphs = new TelemetryGraphView(this.els.graphsHost);
    this.bindEvents();
    this.renderScenarioList();
    this.refreshFileExplorer();

    // Open the first example program in a tab (never auto-executed!)
    const all = this.library.getAll();
    if (all.length > 0) {
      this.openProgramInTab(all[0].id);
    }
  }

  private buildMarkup(): string {
    return `
      <div class="ws-shell hidden" id="ws-shell">
        <div class="ws-splitter-v" id="ws-splitter-v" title="Drag to resize workspace width"></div>
        <div class="ws-inner">
          <!-- Top IDE Control Bar -->
          <div class="ws-topbar">
            <div class="ws-title-group">
              <span class="ws-badge">FLIGHT COMPUTER IDE</span>
              <select class="ws-select" id="ws-craft-select" title="Target Spacecraft Flight Computer"></select>
              <span class="ws-auth-badge" id="ws-auth-badge">ASSISTED</span>
              <span class="ws-scenario-tag" id="ws-scenario-tag">STANDARD</span>
            </div>

            <div class="ws-exec-group">
              <button class="ws-btn run" id="ws-btn-run" title="Deploy & Run active program on selected spacecraft">RUN</button>
              <button class="ws-btn" id="ws-btn-pause" title="Pause / Resume program">PAUSE</button>
              <button class="ws-btn" id="ws-btn-step" title="Single-step update while simulation is paused">STEP</button>
              <button class="ws-btn" id="ws-btn-stop" title="Stop program">STOP</button>
              <button class="ws-btn override" id="ws-btn-override" title="Immediate Manual Override (Esc)">MANUAL OVERRIDE</button>
              <select class="ws-select compact" id="ws-hz-select" title="Flight Computer Update Rate (Sim Time)">
                <option value="5">5 Hz</option>
                <option value="10" selected>10 Hz</option>
                <option value="20">20 Hz</option>
              </select>
            </div>

            <div class="ws-mode-group">
              <button class="ws-btn" id="ws-btn-split">SPLIT</button>
              <button class="ws-btn" id="ws-btn-full">FULL</button>
              <button class="ws-btn" id="ws-btn-close" title="Close Workspace (F)">CLOSE</button>
            </div>
          </div>

          <!-- Main Body: File Explorer + Monaco Editor + Bottom Utility Dock -->
          <div class="ws-body">
            <aside class="ws-sidebar" id="ws-sidebar">
              <div class="ws-side-header">
                <span>PROGRAMS</span>
                <div class="ws-filter-pills">
                  <button class="ws-mini-btn active" data-lang-filter="all">ALL</button>
                  <button class="ws-mini-btn" data-lang-filter="javascript">JS</button>
                  <button class="ws-mini-btn" data-lang-filter="python">PY</button>
                </div>
              </div>
              <div class="ws-side-actions">
                <button class="ws-mini-btn" id="ws-new-js">+ JS</button>
                <button class="ws-mini-btn" id="ws-new-py">+ PY</button>
                <button class="ws-mini-btn" id="ws-import">IMPORT</button>
                <button class="ws-mini-btn" id="ws-restore" title="Restore built-in examples">EXAMPLES</button>
                <input type="file" id="ws-file-input" accept=".js,.py,.txt" class="hidden" />
              </div>
              <div class="ws-file-list" id="ws-file-list"></div>
            </aside>

            <div class="ws-main">
              <!-- Editor Tab Strip & File Actions -->
              <div class="ws-tabbar">
                <div class="ws-tabs" id="ws-tabs"></div>
                <div class="ws-file-ops">
                  <span class="ws-lang-tag" id="ws-lang-tag">JS</span>
                  <button class="ws-mini-btn" id="ws-btn-save" title="Save (Ctrl+S)">SAVE</button>
                  <button class="ws-mini-btn" id="ws-btn-rename">RENAME</button>
                  <button class="ws-mini-btn" id="ws-btn-dup">DUP</button>
                  <button class="ws-mini-btn" id="ws-btn-export">EXPORT</button>
                  <button class="ws-mini-btn danger" id="ws-btn-del">DEL</button>
                </div>
              </div>

              <!-- Monaco Editor Host -->
              <div class="ws-editor-host" id="ws-editor-host">
                <div class="ws-editor-placeholder">Loading Monaco Code Editor…</div>
              </div>

              <!-- Horizontal Resizer -->
              <div class="ws-splitter-h" id="ws-splitter-h" title="Drag to resize bottom panel"></div>

              <!-- Bottom Utility Panel -->
              <div class="ws-bottom" id="ws-bottom">
                <div class="ws-bottom-tabs">
                  <button class="ws-btab active" data-btab="console">CONSOLE</button>
                  <button class="ws-btab" data-btab="debug">DEBUG &amp; TELEMETRY</button>
                  <button class="ws-btab" data-btab="graphs">TELEMETRY GRAPHS</button>
                  <button class="ws-btab" data-btab="scenarios">TEST SCENARIOS (7)</button>
                  <button class="ws-btab" data-btab="docs">API DOCS</button>
                  <span class="ws-runtime-status" id="ws-runtime-status">Idle</span>
                </div>

                <div class="ws-bottom-body">
                  <!-- Console Tab -->
                  <div class="ws-pane" id="pane-console">
                    <div class="ws-pane-bar">
                      <span id="ws-console-meta">0 entries</span>
                      <button class="ws-mini-btn" id="ws-clear-console">CLEAR</button>
                    </div>
                    <div class="ws-console-log" id="ws-console-log"></div>
                  </div>

                  <!-- Debug & Telemetry Inspector Tab -->
                  <div class="ws-pane hidden" id="pane-debug">
                    <div class="ws-debug-grid">
                      <div class="ws-debug-box">
                        <div class="ws-box-title">RUNTIME STATS &amp; COMMANDS</div>
                        <div class="ws-kv-list" id="ws-debug-stats"></div>
                        <div class="ws-box-title mt">LAST ACCEPTED COMMAND</div>
                        <pre class="ws-code-mini" id="ws-last-cmd">None</pre>
                        <div class="ws-box-title mt">REJECTED COMMANDS</div>
                        <div class="ws-reject-list" id="ws-reject-list">None</div>
                      </div>
                      <div class="ws-debug-box">
                        <div class="ws-box-title">CUSTOM PROGRAM VARIABLES</div>
                        <div class="ws-kv-list" id="ws-custom-vars">None recorded via api.record()</div>
                        <div class="ws-box-title mt">LIVE TELEMETRY INSPECTOR</div>
                        <div class="ws-kv-list" id="ws-live-telem"></div>
                        <div class="ws-box-title mt">FAULT HISTORY</div>
                        <div class="ws-reject-list" id="ws-fault-history">No faults</div>
                      </div>
                    </div>
                  </div>

                  <!-- Telemetry Graphs & Recorder Tab -->
                  <div class="ws-pane hidden" id="pane-graphs">
                    <div class="ws-pane-bar">
                      <span>RECORDER:</span>
                      <select class="ws-select compact" id="ws-rec-hz">
                        <option value="1">1 Hz</option>
                        <option value="2" selected>2 Hz</option>
                        <option value="5">5 Hz</option>
                        <option value="10">10 Hz</option>
                      </select>
                      <button class="ws-mini-btn" id="ws-rec-clear">CLEAR DATA</button>
                      <button class="ws-mini-btn" id="ws-rec-csv">EXPORT CSV</button>
                      <button class="ws-mini-btn" id="ws-rec-json">EXPORT JSON</button>
                    </div>
                    <div class="ws-graphs-host" id="ws-graphs-host"></div>
                  </div>

                  <!-- Scenarios Tab -->
                  <div class="ws-pane hidden" id="pane-scenarios">
                    <div class="ws-pane-bar">
                      <span>Sandbox testing environments initialize valid spacecraft states immediately.</span>
                      <button class="ws-mini-btn" id="ws-scenario-restart">RESTART CURRENT</button>
                    </div>
                    <div class="ws-scenario-grid" id="ws-scenario-grid"></div>
                  </div>

                  <!-- API Documentation Tab -->
                  <div class="ws-pane hidden" id="pane-docs">
                    <div class="ws-docs-scroll">${API_DOCUMENTATION_HTML}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  private cacheElements(): void {
    const q = (id: string) => this.root.querySelector(`#${id}`) as HTMLElement;
    this.els = {
      shell: q('ws-shell'),
      splitterV: q('ws-splitter-v'),
      splitterH: q('ws-splitter-h'),
      craftSelect: q('ws-craft-select'),
      authBadge: q('ws-auth-badge'),
      scenarioTag: q('ws-scenario-tag'),
      btnRun: q('ws-btn-run'),
      btnPause: q('ws-btn-pause'),
      btnStep: q('ws-btn-step'),
      btnStop: q('ws-btn-stop'),
      btnOverride: q('ws-btn-override'),
      hzSelect: q('ws-hz-select'),
      btnSplit: q('ws-btn-split'),
      btnFull: q('ws-btn-full'),
      btnClose: q('ws-btn-close'),
      newJs: q('ws-new-js'),
      newPy: q('ws-new-py'),
      btnImport: q('ws-import'),
      btnRestore: q('ws-restore'),
      fileInput: q('ws-file-input'),
      fileList: q('ws-file-list'),
      tabs: q('ws-tabs'),
      langTag: q('ws-lang-tag'),
      btnSave: q('ws-btn-save'),
      btnRename: q('ws-btn-rename'),
      btnDup: q('ws-btn-dup'),
      btnExport: q('ws-btn-export'),
      btnDel: q('ws-btn-del'),
      editorHost: q('ws-editor-host'),
      bottom: q('ws-bottom'),
      runtimeStatus: q('ws-runtime-status'),
      consoleMeta: q('ws-console-meta'),
      consoleLog: q('ws-console-log'),
      clearConsole: q('ws-clear-console'),
      debugStats: q('ws-debug-stats'),
      lastCmd: q('ws-last-cmd'),
      rejectList: q('ws-reject-list'),
      customVars: q('ws-custom-vars'),
      liveTelem: q('ws-live-telem'),
      faultHistory: q('ws-fault-history'),
      recHz: q('ws-rec-hz'),
      recClear: q('ws-rec-clear'),
      recCsv: q('ws-rec-csv'),
      recJson: q('ws-rec-json'),
      graphsHost: q('ws-graphs-host'),
      scenarioGrid: q('ws-scenario-grid'),
      scenarioRestart: q('ws-scenario-restart'),
    };
  }

  private bindEvents(): void {
    // Workspace mode buttons
    this.els.btnSplit.addEventListener('click', () => this.setMode('SPLIT'));
    this.els.btnFull.addEventListener('click', () => this.setMode('FULL'));
    this.els.btnClose.addEventListener('click', () => this.setMode('CLOSED'));

    // Connected spacecraft selector
    (this.els.craftSelect as HTMLSelectElement).addEventListener('change', (e) => {
      const id = (e.target as HTMLSelectElement).value;
      this.selectedCraftId = id;
      this.lastConsoleLen = -1;
      this.callbacks.onSelectSpacecraft(id);
    });

    // Execution frequency selector
    (this.els.hzSelect as HTMLSelectElement).addEventListener('change', (e) => {
      const hz = Number((e.target as HTMLSelectElement).value);
      this.fcManager.getComputer(this.selectedCraftId).updateHz = hz;
    });

    // Program execution buttons
    this.els.btnRun.addEventListener('click', () => void this.deployAndRunActiveProgram());
    this.els.btnPause.addEventListener('click', () => {
      const fc = this.fcManager.getComputer(this.selectedCraftId);
      if (fc.runState === 'RUNNING') this.fcManager.pauseProgram(this.selectedCraftId, this.planet.planetTimeS);
      else if (fc.runState === 'PAUSED') this.fcManager.resumeProgram(this.selectedCraftId, this.planet.planetTimeS);
    });
    this.els.btnStep.addEventListener('click', () => {
      const craft = this.getSelectedCraft();
      if (craft) this.fcManager.singleStepWhilePaused(craft, this.spacecraftManager, this.planet);
    });
    this.els.btnStop.addEventListener('click', () => {
      const craft = this.getSelectedCraft();
      if (craft) this.fcManager.stopProgram(craft, this.planet.planetTimeS);
    });
    this.els.btnOverride.addEventListener('click', () => {
      const craft = this.getSelectedCraft();
      if (craft) this.fcManager.manualOverride(craft, this.planet.planetTimeS);
    });

    // Language filter buttons
    this.root.querySelectorAll<HTMLButtonElement>('[data-lang-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.languageFilter = btn.dataset.langFilter as 'all' | ProgramLanguage;
        this.root.querySelectorAll('[data-lang-filter]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.refreshFileExplorer();
      });
    });

    // File CRUD & Import/Export
    this.els.newJs.addEventListener('click', () => void this.createNewProgram('javascript'));
    this.els.newPy.addEventListener('click', () => void this.createNewProgram('python'));
    this.els.btnSave.addEventListener('click', () => void this.saveCurrentProgram());
    this.els.btnRename.addEventListener('click', () => void this.renameCurrentProgram());
    this.els.btnDup.addEventListener('click', () => void this.duplicateCurrentProgram());
    this.els.btnDel.addEventListener('click', () => void this.deleteCurrentProgram());
    this.els.btnExport.addEventListener('click', () => {
      const p = this.getActiveProgramWithDraft();
      if (p) this.library.exportProgram(p);
    });
    this.els.btnRestore.addEventListener('click', async () => {
      await this.library.restoreExamples();
      this.refreshFileExplorer();
    });
    this.els.btnImport.addEventListener('click', () => (this.els.fileInput as HTMLInputElement).click());
    (this.els.fileInput as HTMLInputElement).addEventListener('change', (e) => void this.handleFileImport(e));

    // Bottom tabs
    this.root.querySelectorAll<HTMLButtonElement>('[data-btab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeBottomTab = btn.dataset.btab as BottomTab;
        this.root.querySelectorAll('[data-btab]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.root.querySelectorAll('.ws-pane').forEach((p) => p.classList.add('hidden'));
        this.root.querySelector(`#pane-${this.activeBottomTab}`)?.classList.remove('hidden');
      });
    });

    // Console & Recorder controls
    this.els.clearConsole.addEventListener('click', () => {
      this.fcManager.getComputer(this.selectedCraftId).clearConsole();
      this.lastConsoleLen = -1;
    });
    (this.els.recHz as HTMLSelectElement).addEventListener('change', (e) => {
      this.recorder.sampleHz = Number((e.target as HTMLSelectElement).value);
    });
    this.els.recClear.addEventListener('click', () => this.recorder.clearCraft(this.selectedCraftId));
    this.els.recCsv.addEventListener('click', () => {
      const c = this.getSelectedCraft();
      if (c) this.recorder.exportCsv(c.id, c.name);
    });
    this.els.recJson.addEventListener('click', () => {
      const c = this.getSelectedCraft();
      if (c) this.recorder.exportJson(c.id, c.name);
    });
    this.els.scenarioRestart.addEventListener('click', () => {
      this.callbacks.onLoadScenario(this.currentScenarioId, true);
    });

    // Vertical split resizer (drag left edge of split workspace)
    let draggingV = false;
    this.els.splitterV.addEventListener('pointerdown', (e) => {
      draggingV = true;
      this.els.splitterV.setPointerCapture(e.pointerId);
    });
    this.els.splitterV.addEventListener('pointermove', (e) => {
      if (!draggingV || this.mode !== 'SPLIT') return;
      this.splitWidthPx = Math.max(460, Math.min(window.innerWidth - 260, window.innerWidth - e.clientX));
      this.els.shell.style.width = `${this.splitWidthPx}px`;
      document.documentElement.style.setProperty('--ws-split-width', `${this.splitWidthPx}px`);
      this.callbacks.onSplitResize?.(this.splitWidthPx);
      this.editor?.layout();
    });
    this.els.splitterV.addEventListener('pointerup', () => {
      draggingV = false;
    });

    // Horizontal resizer (between Monaco editor and bottom console/graphs panel)
    let draggingH = false;
    let startY = 0;
    let startH = this.bottomHeightPx;
    this.els.splitterH.addEventListener('pointerdown', (e) => {
      draggingH = true;
      startY = e.clientY;
      startH = this.bottomHeightPx;
      this.els.splitterH.setPointerCapture(e.pointerId);
    });
    this.els.splitterH.addEventListener('pointermove', (e) => {
      if (!draggingH) return;
      const dy = startY - e.clientY;
      this.bottomHeightPx = Math.max(130, Math.min(460, startH + dy));
      this.els.bottom.style.height = `${this.bottomHeightPx}px`;
      this.editor?.layout();
    });
    this.els.splitterH.addEventListener('pointerup', () => {
      draggingH = false;
    });

    // Ctrl+S inside workspace saves current program cleanly
    this.els.shell.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void this.saveCurrentProgram();
      }
      // Allow Escape to ALWAYS propagate for immediate Manual Override; isolate all other keys
      if (e.code !== 'Escape') {
        e.stopPropagation();
      }
    });
  }

  public setMode(newMode: WorkspaceMode): void {
    this.mode = newMode;
    this.els.shell.classList.toggle('hidden', newMode === 'CLOSED');
    this.els.shell.classList.toggle('full', newMode === 'FULL');
    this.els.shell.classList.toggle('split', newMode === 'SPLIT');
    this.els.btnSplit.classList.toggle('active', newMode === 'SPLIT');
    this.els.btnFull.classList.toggle('active', newMode === 'FULL');

    if (newMode === 'SPLIT') {
      this.els.shell.style.width = `${this.splitWidthPx}px`;
      document.documentElement.style.setProperty('--ws-split-width', `${this.splitWidthPx}px`);
    } else if (newMode === 'FULL') {
      this.els.shell.style.width = '100%';
    }

    this.els.bottom.style.height = `${this.bottomHeightPx}px`;
    this.callbacks.onModeChange(newMode);

    if (newMode !== 'CLOSED') {
      void this.ensureMonacoInitialized();
      setTimeout(() => this.editor?.layout(), 40);
    }
  }

  public toggleWorkspace(): void {
    this.setMode(this.mode === 'CLOSED' ? 'SPLIT' : 'CLOSED');
  }

  public setScenarioMeta(id: ScenarioId, isSandbox: boolean): void {
    this.currentScenarioId = id;
    this.els.scenarioTag.textContent = isSandbox ? `SANDBOX: ${id.toUpperCase()}` : 'STANDARD SIM';
    this.els.scenarioTag.classList.toggle('sandbox', isSandbox);
    this.renderScenarioList();
  }

  public syncActiveSpacecraft(id: string): void {
    this.selectedCraftId = id;
    this.lastConsoleLen = -1;
  }

  public getActiveProgramWithDraft(): StoredProgram | null {
    if (!this.activeProgramId) return null;
    const base = this.library.getById(this.activeProgramId);
    if (!base) return null;
    const draft = this.dirtyPrograms.get(base.id);
    return draft !== undefined ? { ...base, code: draft } : base;
  }

  private getSelectedCraft() {
    return (
      this.spacecraftManager.spacecraft.find((c) => c.id === this.selectedCraftId) ??
      this.spacecraftManager.activeSpacecraft
    );
  }

  private async ensureMonacoInitialized(): Promise<void> {
    if (this.editor || this.editorInitializing) return;
    this.editorInitializing = true;
    try {
      const monaco = await loadMonaco();
      this.monaco = monaco;
      this.els.editorHost.innerHTML = '';

      const prog = this.getActiveProgramWithDraft();
      this.editor = monaco.editor.create(this.els.editorHost, {
        value: prog?.code ?? '',
        language: prog?.language ?? 'javascript',
        theme: 'reentry-aerospace',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 12.5,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        tabSize: 2,
        renderWhitespace: 'selection',
      });

      this.editor.onDidChangeModelContent(() => {
        if (!this.activeProgramId || !this.editor) return;
        this.dirtyPrograms.set(this.activeProgramId, this.editor.getValue());
        this.renderTabs();
      });
    } finally {
      this.editorInitializing = false;
    }
  }

  private openProgramInTab(id: string): void {
    const prog = this.library.getById(id);
    if (!prog) return;
    if (!this.openTabIds.includes(id)) {
      this.openTabIds.push(id);
    }
    this.activeProgramId = id;
    this.els.langTag.textContent = prog.language === 'python' ? 'PYTHON' : 'JAVASCRIPT';

    if (this.editor && this.monaco) {
      const code = this.dirtyPrograms.get(id) ?? prog.code;
      const model = this.editor.getModel();
      if (model) {
        this.monaco.editor.setModelLanguage(model, prog.language);
        if (model.getValue() !== code) {
          model.setValue(code);
        }
        this.monaco.editor.setModelMarkers(model, 'reentry-fc', []);
      }
    }

    this.renderTabs();
    this.refreshFileExplorer();
  }

  private async deployAndRunActiveProgram(): Promise<void> {
    const prog = this.getActiveProgramWithDraft();
    const craft = this.getSelectedCraft();
    if (!prog || !craft) return;

    // Save changes cleanly before deploying
    await this.saveCurrentProgram();
    this.fcManager.installProgram(craft.id, prog.id, prog.name, prog.language, prog.code);
    this.fcManager.startProgram(craft, this.spacecraftManager, this.planet);
    this.lastConsoleLen = -1;
  }

  private async saveCurrentProgram(): Promise<void> {
    const prog = this.getActiveProgramWithDraft();
    if (!prog) return;
    await this.library.save(prog);
    this.dirtyPrograms.delete(prog.id);
    this.renderTabs();
    this.refreshFileExplorer();
  }

  private async createNewProgram(language: ProgramLanguage): Promise<void> {
    const defName = language === 'python' ? 'my_controller.py' : 'my_controller.js';
    const name = window.prompt(`New ${language} program filename:`, defName);
    if (!name) return;
    const created = await this.library.create(name, language);
    this.openProgramInTab(created.id);
  }

  private async renameCurrentProgram(): Promise<void> {
    const prog = this.getActiveProgramWithDraft();
    if (!prog) return;
    const next = window.prompt('Rename program:', prog.name);
    if (!next || next === prog.name) return;
    await this.library.rename(prog.id, next);
    this.renderTabs();
    this.refreshFileExplorer();
  }

  private async duplicateCurrentProgram(): Promise<void> {
    const prog = this.getActiveProgramWithDraft();
    if (!prog) return;
    const copy = await this.library.duplicate(prog.id);
    if (copy) this.openProgramInTab(copy.id);
  }

  private async deleteCurrentProgram(): Promise<void> {
    const prog = this.getActiveProgramWithDraft();
    if (!prog) return;
    if (!window.confirm(`Delete "${prog.name}" from local library?`)) return;
    await this.library.remove(prog.id);
    this.dirtyPrograms.delete(prog.id);
    this.openTabIds = this.openTabIds.filter((tid) => tid !== prog.id);
    const next = this.openTabIds[0] ?? this.library.getAll()[0]?.id ?? null;
    this.activeProgramId = next;
    if (next) this.openProgramInTab(next);
    else {
      this.renderTabs();
      this.refreshFileExplorer();
    }
  }

  private async handleFileImport(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const text = await file.text();
    const lang: ProgramLanguage = file.name.toLowerCase().endsWith('.py') ? 'python' : 'javascript';
    // Explicitly NEVER auto-executes imported files — opens in editor for inspection!
    const created = await this.library.create(file.name, lang, text);
    this.openProgramInTab(created.id);
  }

  private refreshFileExplorer(): void {
    const progs = this.library
      .getAll()
      .filter((p) => this.languageFilter === 'all' || p.language === this.languageFilter);
    this.els.fileList.innerHTML = '';

    for (const p of progs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ws-file-item${p.id === this.activeProgramId ? ' active' : ''}`;
      const badge = p.language === 'python' ? 'PY' : 'JS';
      btn.innerHTML = `<span class="ws-ext ext-${badge.toLowerCase()}">${badge}</span><span class="ws-fname">${p.name}</span>`;
      btn.addEventListener('click', () => this.openProgramInTab(p.id));
      this.els.fileList.appendChild(btn);
    }
  }

  private renderTabs(): void {
    this.els.tabs.innerHTML = '';
    for (const id of this.openTabIds) {
      const p = this.library.getById(id);
      if (!p) continue;
      const dirty = this.dirtyPrograms.has(id);
      const tab = document.createElement('div');
      tab.className = `ws-tab${id === this.activeProgramId ? ' active' : ''}`;
      tab.innerHTML = `<span class="ws-tab-lbl">${p.name}${dirty ? ' •' : ''}</span><button class="ws-tab-x" title="Close tab">&times;</button>`;
      tab.addEventListener('click', () => this.openProgramInTab(id));
      tab.querySelector('.ws-tab-x')!.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openTabIds = this.openTabIds.filter((t) => t !== id);
        if (this.activeProgramId === id) {
          this.activeProgramId = this.openTabIds[0] ?? null;
          if (this.activeProgramId) this.openProgramInTab(this.activeProgramId);
        }
        this.renderTabs();
      });
      this.els.tabs.appendChild(tab);
    }
  }

  private renderScenarioList(): void {
    this.els.scenarioGrid.innerHTML = '';
    for (const sc of FLIGHT_SCENARIOS) {
      const card = document.createElement('div');
      card.className = `ws-sc-card${sc.id === this.currentScenarioId ? ' active' : ''}`;
      card.innerHTML = `
        <div class="ws-sc-head">
          <span class="ws-sc-name">${sc.name}</span>
          <span class="ws-sc-badge ${sc.isSandbox ? 'sandbox' : 'std'}">${sc.badge}</span>
        </div>
        <div class="ws-sc-desc">${sc.description}</div>
        <div class="ws-sc-actions">
          <button class="ws-mini-btn load-sc">LOAD SCENARIO</button>
          ${sc.recommendedProgramId ? '<button class="ws-mini-btn load-ex">OPEN STARTER CODE</button>' : ''}
        </div>
      `;
      card.querySelector('.load-sc')!.addEventListener('click', () => {
        this.callbacks.onLoadScenario(sc.id, false);
      });
      const exBtn = card.querySelector('.load-ex');
      if (exBtn && sc.recommendedProgramId) {
        exBtn.addEventListener('click', () => this.openProgramInTab(sc.recommendedProgramId!));
      }
      this.els.scenarioGrid.appendChild(card);
    }
  }

  /**
   * Throttled live UI update (~12 Hz) when workspace is open.
   */
  public update(activeTelemetry: TelemetrySnapshot): void {
    if (this.mode === 'CLOSED') return;

    const now = performance.now();
    if (now - this.lastUiTick < 80) return;
    this.lastUiTick = now;

    // Sync spacecraft selector dropdown
    const craftSig = this.spacecraftManager.spacecraft.map((c) => `${c.id}:${c.name}`).join('|');
    if (craftSig !== this.lastCraftListSig) {
      this.lastCraftListSig = craftSig;
      const sel = this.els.craftSelect as HTMLSelectElement;
      sel.innerHTML = this.spacecraftManager.spacecraft
        .map((c) => `<option value="${c.id}">${c.name}</option>`)
        .join('');
    }
    if (!this.spacecraftManager.spacecraft.some((c) => c.id === this.selectedCraftId)) {
      this.selectedCraftId = this.spacecraftManager.activeId;
    }
    (this.els.craftSelect as HTMLSelectElement).value = this.selectedCraftId;

    const fc = this.fcManager.getComputer(this.selectedCraftId);
    this.els.authBadge.textContent = fc.authority;
    this.els.authBadge.dataset.auth = fc.authority.toLowerCase();
    this.els.runtimeStatus.textContent = `${fc.runtimeStatusText} • ${fc.stats.lastExecMs.toFixed(1)} ms`;
    this.els.btnPause.textContent = fc.runState === 'PAUSED' ? 'RESUME' : 'PAUSE';
    (this.els.hzSelect as HTMLSelectElement).value = String(fc.updateHz);

    // Highlight runtime/syntax fault line right inside Monaco Editor!
    if (this.editor && this.monaco) {
      const model = this.editor.getModel();
      if (model) {
        const latestFault = fc.faultHistory[0];
        if (fc.runState === 'FAULT' && latestFault?.line && fc.programId === this.activeProgramId) {
          this.monaco.editor.setModelMarkers(model, 'reentry-fc', [
            {
              startLineNumber: latestFault.line,
              endLineNumber: latestFault.line,
              startColumn: 1,
              endColumn: model.getLineMaxColumn(Math.min(latestFault.line, model.getLineCount())),
              message: latestFault.message,
              severity: this.monaco.MarkerSeverity.Error,
            },
          ]);
        } else if (fc.runState !== 'FAULT') {
          this.monaco.editor.setModelMarkers(model, 'reentry-fc', []);
        }
      }
    }

    // Update Console tab
    if (this.activeBottomTab === 'console' && fc.consoleHistory.length !== this.lastConsoleLen) {
      this.lastConsoleLen = fc.consoleHistory.length;
      this.els.consoleMeta.textContent = `${fc.consoleHistory.length} entries • ${fc.programName}`;
      this.els.consoleLog.innerHTML = fc.consoleHistory
        .map(
          (e) =>
            `<div class="log-line log-${e.level}"><span class="log-t">[${e.simTime.toFixed(1)}s]</span> ${escapeHtml(e.message)}</div>`
        )
        .join('');
      this.els.consoleLog.scrollTop = this.els.consoleLog.scrollHeight;
    }

    // Update Debug & Telemetry Inspector tab
    if (this.activeBottomTab === 'debug') {
      const memStr = fc.stats.memoryBytes !== null ? `${(fc.stats.memoryBytes / 1024).toFixed(1)} KB` : 'N/A (Pyodide)';
      this.els.debugStats.innerHTML = `
        <div>State: <b>${fc.runState}</b> (${fc.language.toUpperCase()})</div>
        <div>Rate: <b>${fc.updateHz} Hz</b> • Ticks: <b>${fc.stats.ticksExecuted}</b> (Drop: ${fc.stats.droppedTicks})</div>
        <div>Exec: <b>${fc.stats.lastExecMs.toFixed(2)} ms</b> (Avg ${fc.stats.avgExecMs.toFixed(2)} / Max ${fc.stats.maxExecMs.toFixed(2)})</div>
        <div>Memory: <b>${memStr}</b></div>
      `;

      this.els.lastCmd.textContent = fc.lastAcceptedCommand
        ? JSON.stringify(fc.lastAcceptedCommand, null, 2)
        : 'None';

      this.els.rejectList.innerHTML =
        fc.lastRejections.length === 0
          ? '<span class="muted">No rejected commands</span>'
          : fc.lastRejections
              .map((r) => `<div class="rej-row"><b>${r.field}</b>: ${escapeHtml(r.reason)}</div>`)
              .join('');

      const cvEntries = Object.entries(fc.customVariables);
      this.els.customVars.innerHTML =
        cvEntries.length === 0
          ? '<span class="muted">Call api.record("key", value) to inspect custom state</span>'
          : cvEntries.map(([k, v]) => `<div>${escapeHtml(k)}: <b>${escapeHtml(String(v))}</b></div>`).join('');

      this.els.liveTelem.innerHTML = `
        <div>ALT ASL / AGL: <b>${(activeTelemetry.altitudeASLM / 1000).toFixed(2)} km</b> / <b>${activeTelemetry.altitudeAGLM.toFixed(0)} m</b></div>
        <div>VEL SURF / INER: <b>${activeTelemetry.totalVelocityMs.toFixed(1)}</b> / <b>${activeTelemetry.inertialVelocityMs.toFixed(1)} m/s</b></div>
        <div>PITCH / TILT: <b>${activeTelemetry.pitchDeg.toFixed(1)}°</b> / <b>${activeTelemetry.tiltFromVerticalDeg.toFixed(1)}°</b></div>
        <div>FUEL / THROTTLE: <b>${activeTelemetry.fuelPercent.toFixed(1)}%</b> / <b>${activeTelemetry.throttlePercent.toFixed(0)}%</b></div>
        <div>ORBIT: <b>${activeTelemetry.orbital.classification}</b></div>
      `;

      this.els.faultHistory.innerHTML =
        fc.faultHistory.length === 0
          ? '<span class="muted">No faults recorded</span>'
          : fc.faultHistory
              .slice(0, 6)
              .map(
                (f) =>
                  `<div class="rej-row">[${f.simTime.toFixed(1)}s${f.line ? ` L${f.line}` : ''}] ${escapeHtml(f.message)}</div>`
              )
              .join('');
    }

    // Update Telemetry Graphs tab
    if (this.activeBottomTab === 'graphs') {
      this.graphs.render(this.recorder.getRecording(this.selectedCraftId));
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

import type * as Monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';

let monacoPromise: Promise<typeof Monaco> | null = null;
let configured = false;

const REENTRY_JS_DTS = `
interface ReentryTelemetry {
  readonly apiVersion: string;
  readonly simTime: number;
  readonly met: number;
  readonly dt: number;
  readonly vehicle: {
    readonly id: string;
    readonly name: string;
    readonly role: 'stack' | 'booster' | 'upper_stage' | 'fairing' | 'payload';
    readonly status: string;
    readonly massKg: number;
    readonly propellantKg: number;
    readonly propellantCapacityKg: number;
    readonly propellantFraction: number;
    readonly hasLandingGear: boolean;
    readonly canStage: boolean;
    readonly nextStageLabel: string;
  };
  readonly position: {
    readonly altitudeASL: number;
    readonly altitudeAGL: number;
    readonly latitudeDeg: number;
    readonly longitudeDeg: number;
    readonly distanceFromPadM: number;
  };
  readonly velocity: {
    readonly vertical: number;
    readonly horizontal: number;
    readonly surfaceSpeed: number;
    readonly inertialSpeed: number;
    readonly mach: number;
    readonly surfaceLocal: { readonly east: number; readonly up: number; readonly south: number };
  };
  readonly attitude: {
    readonly pitchDeg: number;
    readonly headingDeg: number;
    readonly rollDeg: number;
    readonly tiltFromVerticalDeg: number;
    readonly angularVelocityBody: { readonly x: number; readonly y: number; readonly z: number };
    readonly noseLocal: { readonly x: number; readonly y: number; readonly z: number };
    readonly rightLocal: { readonly x: number; readonly y: number; readonly z: number };
  };
  readonly acceleration: { readonly feltMs2: number; readonly gForce: number };
  readonly propulsion: { readonly engineIgnited: boolean; readonly throttle: number; readonly thrustN: number };
  readonly environment: {
    readonly atmosphericDensity: number;
    readonly dynamicPressurePa: number;
    readonly gravityMs2: number;
    readonly inSpace: boolean;
    readonly reentryHeat: number;
  };
  readonly orbit: {
    readonly valid: boolean;
    readonly classification: string;
    readonly apoapsisM: number | null;
    readonly periapsisM: number | null;
    readonly inclinationDeg: number | null;
    readonly eccentricity: number | null;
    readonly periodS: number | null;
    readonly timeToApoapsisS: number | null;
    readonly timeToPeriapsisS: number | null;
  };
  readonly controls: { readonly sasMode: string; readonly gearDeployed: boolean };
  readonly landingTarget: {
    readonly name: string;
    readonly distanceM: number;
    readonly relativeEastM: number;
    readonly relativeSouthM: number;
    readonly elevationM: number;
  };
}

interface ReentryFlightAPI {
  readonly version: string;
  setThrottle(value: number): void;
  ignite(): void;
  shutdown(): void;
  setPitch(value: number): void;
  setYaw(value: number): void;
  setRoll(value: number): void;
  setAttitude(pitch?: number, yaw?: number, roll?: number): void;
  setSasMode(mode: 'OFF' | 'HOLD' | 'RETROGRADE' | 'VERTICAL'): void;
  setLandingGear(deployed: boolean): void;
  stage(): void;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  record(key: string, value: number | string | boolean): void;
}

declare const api: ReentryFlightAPI;
`;

/**
 * Lazily imports Monaco Editor, registers Vite web workers, defines the compact
 * dark aerospace theme, and installs REENTRY Flight API v1.0.0 completions for JS & Python.
 */
export async function loadMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    (self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker(_workerId: string, label: string) {
        if (label === 'typescript' || label === 'javascript') {
          return new tsWorker();
        }
        return new editorWorker();
      },
    };

    monacoPromise = import('monaco-editor');
  }

  const monaco = await monacoPromise;

  if (!configured) {
    configured = true;

    monaco.editor.defineTheme('reentry-aerospace', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '687c96' },
        { token: 'keyword', foreground: '6cb6ff' },
        { token: 'number', foreground: 'f5b963' },
        { token: 'string', foreground: '7ee0a8' },
      ],
      colors: {
        'editor.background': '#0a0f18',
        'editor.foreground': '#dce7f5',
        'editorLineNumber.foreground': '#4f627c',
        'editorLineNumber.activeForeground': '#b8cde8',
        'editor.lineHighlightBackground': '#131d2d',
        'editorCursor.foreground': '#4cc9ff',
        'editor.selectionBackground': '#21426b',
      },
    });

    // Inject REENTRY API type definitions into Monaco's JavaScript IntelliSense
    const tsLang = monaco.typescript;
    if (tsLang?.javascriptDefaults) {
      tsLang.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });
      tsLang.javascriptDefaults.setCompilerOptions({
        target: tsLang.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: false,
      });
      tsLang.javascriptDefaults.addExtraLib(REENTRY_JS_DTS, 'ts:reentry-flight-api.d.ts');
    }

    // Register REENTRY Flight API autocomplete suggestions for Python
    const pyItems = [
      ['api.set_throttle', 'api.set_throttle(${1:1.0})', 'Set engine throttle (0.0 to 1.0)'],
      ['api.ignite', 'api.ignite()', 'Request main engine ignition'],
      ['api.shutdown', 'api.shutdown()', 'Request engine cutoff (MECO/SECO)'],
      ['api.set_pitch', 'api.set_pitch(${1:0.0})', 'Set pitch torque command (-1..1)'],
      ['api.set_yaw', 'api.set_yaw(${1:0.0})', 'Set yaw torque command (-1..1)'],
      ['api.set_roll', 'api.set_roll(${1:0.0})', 'Set roll torque command (-1..1)'],
      ['api.set_attitude', 'api.set_attitude(${1:0.0}, ${2:0.0}, ${3:0.0})', 'Set (pitch, yaw, roll)'],
      ['api.set_sas_mode', 'api.set_sas_mode("${1|HOLD,RETROGRADE,VERTICAL,OFF|}")', 'Set SAS mode'],
      ['api.set_landing_gear', 'api.set_landing_gear(${1:True})', 'Deploy or retract landing gear'],
      ['api.stage', 'api.stage()', 'Request next stage separation / deploy'],
      ['api.log', 'api.log(${1:"message"})', 'Log message to flight computer console'],
      ['api.record', 'api.record("${1:metric}", ${2:value})', 'Record custom variable for telemetry graphs'],
      ['t.position.altitudeASL', 't.position.altitudeASL', 'Altitude above sea level (m)'],
      ['t.position.altitudeAGL', 't.position.altitudeAGL', 'Altitude above ground level (m)'],
      ['t.velocity.vertical', 't.velocity.vertical', 'Vertical velocity (m/s)'],
      ['t.velocity.surfaceSpeed', 't.velocity.surfaceSpeed', 'Surface-relative speed (m/s)'],
      ['t.velocity.inertialSpeed', 't.velocity.inertialSpeed', 'Inertial orbital speed (m/s)'],
      ['t.orbit.apoapsisM', 't.orbit.apoapsisM', 'Predicted apoapsis altitude (m)'],
      ['t.orbit.periapsisM', 't.orbit.periapsisM', 'Predicted periapsis altitude (m)'],
      ['t.vehicle.propellantFraction', 't.vehicle.propellantFraction', 'Remaining fuel fraction (0..1)'],
    ];

    monaco.languages.registerCompletionItemProvider('python', {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: pyItems.map(([label, insertText, detail]) => ({
            label,
            kind: monaco.languages.CompletionItemKind.Method,
            insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail,
            range,
          })),
        };
      },
    });
  }

  return monaco;
}

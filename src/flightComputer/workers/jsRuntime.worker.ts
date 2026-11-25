import { getQuickJS, QuickJSContext, QuickJSRuntime, QuickJSWASMModule } from 'quickjs-emscripten';
import type {
  ProgramStepResult,
  RawProgramCommand,
  RuntimeWorkerRequest,
  RuntimeWorkerResponse,
} from '../apiTypes';

/**
 * Isolated QuickJS-WASM JavaScript Flight Computer Worker.
 *
 * Security & Determinism Guarantees:
 * - Executes player code strictly inside an empty QuickJS WebAssembly VM (never host eval/Function).
 * - Zero access to DOM, window, fetch, WebSocket, cookies, IndexedDB, localStorage, or sim objects.
 * - Enforces hard memory limit (16 MB), stack limit (256 KB), and interrupt-handler execution budget
 *   so infinite loops (`while(true){}`) terminate cleanly in milliseconds.
 */

// Lock down dangerous host worker globals defensively before running any user scripts
const g = globalThis as Record<string, unknown>;
for (const key of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'indexedDB', 'caches', 'BroadcastChannel']) {
  try {
    Object.defineProperty(g, key, { value: undefined, configurable: false, writable: false });
  } catch {
    // Ignore read-only properties
  }
}

let qjsModule: QuickJSWASMModule | null = null;
let runtime: QuickJSRuntime | null = null;
let vm: QuickJSContext | null = null;

let stepCommand: RawProgramCommand = {};
let stepLogs: Array<{ level: 'log' | 'warn' | 'error'; message: string }> = [];
let stepCustomVars: Record<string, number | string | boolean> = {};
let stepDeadlineMs = Infinity;
let interruptChecks = 0;

const MAX_LOGS_PER_STEP = 24;
const MAX_CUSTOM_VARS = 32;
const MAX_INTERRUPT_CHECKS = 400_000;

const API_BOOTSTRAP_JS = `
const __reentryApi = Object.freeze({
  version: '1.0.0',
  setThrottle(v) { __hostCmd('throttle', v); },
  ignite() { __hostCmd('ignite', true); },
  shutdown() { __hostCmd('shutdown', true); },
  setPitch(v) { __hostCmd('pitch', v); },
  setYaw(v) { __hostCmd('yaw', v); },
  setRoll(v) { __hostCmd('roll', v); },
  setAttitude(pitch, yaw, roll) {
    if (pitch !== undefined) __hostCmd('pitch', pitch);
    if (yaw !== undefined) __hostCmd('yaw', yaw);
    if (roll !== undefined) __hostCmd('roll', roll);
  },
  setSasMode(mode) { __hostCmd('sasMode', mode); },
  setLandingGear(deployed) { __hostCmd('deployGear', deployed); },
  stage() { __hostCmd('stage', true); },
  log(...args) { __hostLog('log', args.map(__fmt).join(' ')); },
  warn(...args) { __hostLog('warn', args.map(__fmt).join(' ')); },
  error(...args) { __hostLog('error', args.map(__fmt).join(' ')); },
  record(key, value) { __hostRecord(String(key), value); },
});

function __fmt(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

globalThis.console = Object.freeze({
  log: (...a) => __reentryApi.log(...a),
  warn: (...a) => __reentryApi.warn(...a),
  error: (...a) => __reentryApi.error(...a),
});
globalThis.api = __reentryApi;
`;

function post(msg: RuntimeWorkerResponse): void {
  self.postMessage(msg);
}

function disposeVm(): void {
  if (vm) {
    try {
      vm.dispose();
    } catch {
      // ignore
    }
    vm = null;
  }
  if (runtime) {
    try {
      runtime.dispose();
    } catch {
      // ignore
    }
    runtime = null;
  }
}

function getVmMemoryBytes(): number | null {
  if (!runtime) return null;
  try {
    const usageHandle = runtime.computeMemoryUsage();
    const usage = vm ? (vm.dump(usageHandle) as { malloc_size?: number } | null) : null;
    usageHandle.dispose();
    return typeof usage?.malloc_size === 'number' ? usage.malloc_size : null;
  } catch {
    return null;
  }
}

function parseErrorLine(stackOrMsg: string): number | null {
  const m = stackOrMsg.match(/flight_program\.js:(\d+)/) || stackOrMsg.match(/:(\d+):/);
  return m ? Number(m[1]) : null;
}

function beginStep(timeLimitMs: number): void {
  stepCommand = {};
  stepLogs = [];
  stepDeadlineMs = performance.now() + timeLimitMs;
  interruptChecks = 0;
}

function installHostBridge(ctx: QuickJSContext): void {
  const cmdFn = ctx.newFunction('__hostCmd', (keyH, valH) => {
    const key = String(ctx.dump(keyH));
    const val = ctx.dump(valH);
    stepCommand[key] = val;
  });
  ctx.setProp(ctx.global, '__hostCmd', cmdFn);
  cmdFn.dispose();

  const logFn = ctx.newFunction('__hostLog', (lvlH, msgH) => {
    if (stepLogs.length >= MAX_LOGS_PER_STEP) return;
    const level = String(ctx.dump(lvlH)) as 'log' | 'warn' | 'error';
    const message = String(ctx.dump(msgH)).slice(0, 400);
    stepLogs.push({ level, message });
  });
  ctx.setProp(ctx.global, '__hostLog', logFn);
  logFn.dispose();

  const recFn = ctx.newFunction('__hostRecord', (keyH, valH) => {
    const key = String(ctx.dump(keyH)).slice(0, 40);
    const val = ctx.dump(valH);
    if (
      (typeof val === 'number' && Number.isFinite(val)) ||
      typeof val === 'string' ||
      typeof val === 'boolean'
    ) {
      if (Object.keys(stepCustomVars).length < MAX_CUSTOM_VARS || key in stepCustomVars) {
        stepCustomVars[key] = typeof val === 'string' ? val.slice(0, 80) : val;
      }
    }
  });
  ctx.setProp(ctx.global, '__hostRecord', recFn);
  recFn.dispose();
}

function evalChecked(ctx: QuickJSContext, code: string, filename: string): { ok: boolean; error?: string; line?: number | null } {
  const res = ctx.evalCode(code, filename);
  if (res.error) {
    const dumped = ctx.dump(res.error);
    res.error.dispose();
    const errText =
      typeof dumped === 'object' && dumped !== null
        ? `${(dumped as { name?: string }).name ?? 'Error'}: ${(dumped as { message?: string }).message ?? JSON.stringify(dumped)}`
        : String(dumped);
    const stackText =
      typeof dumped === 'object' && dumped !== null && typeof (dumped as { stack?: string }).stack === 'string'
        ? (dumped as { stack: string }).stack
        : errText;
    const friendly = errText.includes('interrupted')
      ? 'Execution time / instruction budget exceeded (possible infinite loop).'
      : errText;
    return { ok: false, error: friendly, line: parseErrorLine(stackText) };
  }
  res.value.dispose();
  return { ok: true };
}

async function handleLoad(req: Extract<RuntimeWorkerRequest, { type: 'load' }>): Promise<ProgramStepResult> {
  const t0 = performance.now();
  stepCustomVars = {};
  beginStep(req.timeLimitMs);

  if (!qjsModule) {
    post({ type: 'status', message: 'Initializing QuickJS-WASM sandbox…' });
    qjsModule = await getQuickJS();
  }

  disposeVm();
  runtime = qjsModule.newRuntime();
  runtime.setMemoryLimit(req.memoryLimitBytes);
  runtime.setMaxStackSize(256 * 1024);
  runtime.setInterruptHandler(() => {
    interruptChecks += 1;
    return performance.now() > stepDeadlineMs || interruptChecks > MAX_INTERRUPT_CHECKS;
  });

  vm = runtime.newContext();
  installHostBridge(vm);

  const boot = evalChecked(vm, API_BOOTSTRAP_JS, 'reentry_api.js');
  if (!boot.ok) {
    return {
      ok: false,
      command: {},
      logs: stepLogs,
      customVars: { ...stepCustomVars },
      execTimeMs: performance.now() - t0,
      memoryBytes: getVmMemoryBytes(),
      error: boot.error,
      line: boot.line,
    };
  }

  // Evaluate player program source inside isolated QuickJS context
  const loadRes = evalChecked(vm, req.code, 'flight_program.js');
  if (!loadRes.ok) {
    return {
      ok: false,
      command: {},
      logs: stepLogs,
      customVars: { ...stepCustomVars },
      execTimeMs: performance.now() - t0,
      memoryBytes: getVmMemoryBytes(),
      error: loadRes.error,
      line: loadRes.line,
    };
  }

  // Run optional init(api, telemetry) lifecycle callback
  const telemJson = JSON.stringify(req.telemetry);
  const initInvoke = `
    if (typeof init === 'function') {
      const __t = Object.freeze(JSON.parse(${JSON.stringify(telemJson)}));
      init(__reentryApi, __t);
    }
  `;
  const initRes = evalChecked(vm, initInvoke, 'reentry_init.js');

  return {
    ok: initRes.ok,
    command: { ...stepCommand },
    logs: [...stepLogs],
    customVars: { ...stepCustomVars },
    execTimeMs: performance.now() - t0,
    memoryBytes: getVmMemoryBytes(),
    error: initRes.error,
    line: initRes.line,
  };
}

function handleUpdate(req: Extract<RuntimeWorkerRequest, { type: 'update' }>): ProgramStepResult {
  const t0 = performance.now();
  if (!vm) {
    return {
      ok: false,
      command: {},
      logs: [],
      customVars: {},
      execTimeMs: 0,
      memoryBytes: null,
      error: 'JavaScript runtime not initialized.',
      line: null,
    };
  }

  beginStep(req.timeLimitMs);
  const telemJson = JSON.stringify(req.telemetry);
  const callCode = `
    if (typeof update === 'function') {
      const __t = Object.freeze(JSON.parse(${JSON.stringify(telemJson)}));
      update(__t, __reentryApi);
    }
  `;
  const res = evalChecked(vm, callCode, 'reentry_update.js');
  return {
    ok: res.ok,
    command: { ...stepCommand },
    logs: [...stepLogs],
    customVars: { ...stepCustomVars },
    execTimeMs: performance.now() - t0,
    memoryBytes: getVmMemoryBytes(),
    error: res.error,
    line: res.line,
  };
}

function handleEvent(req: Extract<RuntimeWorkerRequest, { type: 'event' }>): ProgramStepResult {
  const t0 = performance.now();
  if (!vm) {
    return {
      ok: true,
      command: {},
      logs: [],
      customVars: { ...stepCustomVars },
      execTimeMs: 0,
      memoryBytes: null,
    };
  }

  beginStep(req.timeLimitMs);
  const telemJson = JSON.stringify(req.telemetry);
  const payloadJson = JSON.stringify(req.payload);
  const callCode = `
    if (typeof onEvent === 'function') {
      const __t = Object.freeze(JSON.parse(${JSON.stringify(telemJson)}));
      const __p = Object.freeze(JSON.parse(${JSON.stringify(payloadJson)}));
      onEvent(${JSON.stringify(req.eventName)}, __p, __t, __reentryApi);
    }
  `;
  const res = evalChecked(vm, callCode, 'reentry_event.js');
  return {
    ok: res.ok,
    command: { ...stepCommand },
    logs: [...stepLogs],
    customVars: { ...stepCustomVars },
    execTimeMs: performance.now() - t0,
    memoryBytes: getVmMemoryBytes(),
    error: res.error,
    line: res.line,
  };
}

self.onmessage = async (ev: MessageEvent<RuntimeWorkerRequest>) => {
  const req = ev.data;
  try {
    let result: ProgramStepResult;
    if (req.type === 'load') {
      result = await handleLoad(req);
    } else if (req.type === 'update') {
      result = handleUpdate(req);
    } else {
      result = handleEvent(req);
    }
    post({ type: 'result', requestId: req.requestId, result });
  } catch (err) {
    post({
      type: 'result',
      requestId: req.requestId,
      result: {
        ok: false,
        command: {},
        logs: [],
        customVars: { ...stepCustomVars },
        execTimeMs: 0,
        memoryBytes: getVmMemoryBytes(),
        error: err instanceof Error ? err.message : String(err),
        line: null,
      },
    });
  }
};

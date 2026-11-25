import type {
  ProgramStepResult,
  RuntimeWorkerRequest,
  RuntimeWorkerResponse,
} from '../apiTypes';

/**
 * Isolated, Lazy-Loaded Python (Pyodide) Flight Computer Worker.
 *
 * Security & Isolation Architecture:
 * 1. Pyodide is lazy-loaded ONLY when a player runs a Python program.
 * 2. Immediately after Pyodide boots, dangerous host Web Worker globals (`fetch`, `XMLHttpRequest`,
 *    `WebSocket`, `EventSource`, `importScripts`, `indexedDB`, `caches`, `BroadcastChannel`) are
 *    locked down to `undefined`.
 * 3. Inside Python, player code executes in a restricted global namespace with:
 *    - Blocked JS bridge & system modules (`js`, `pyodide`, `pyodide_js`, `micropip`, `os`, `sys`,
 *      `subprocess`, `socket`, `http`, `urllib`, `ctypes`, `importlib`, `pathlib`, `io`, etc.).
 *    - Whitelisted pure-computation `__import__` (`math`, `random`, `json`, `statistics`,
 *      `collections`, `itertools`, `functools`, `dataclasses`, `enum`, `typing`, `re`, `string`).
 *    - Removed `open`, `exec`, `eval`, `compile`, `input`, `breakpoint`.
 * 4. Every `load`/`update`/`event` call runs under a `sys.settrace` step-budget + wall-clock
 *    watchdog so infinite loops (`while True: pass`) terminate cleanly.
 * 5. The outer host `FlightComputerManager` also runs a hard worker termination watchdog.
 */

interface PyodideInterface {
  runPython(code: string): unknown;
  globals: { set(k: string, v: unknown): void; get(k: string): unknown };
}

const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/pyodide.mjs';

let pyodide: PyodideInterface | null = null;
let pyodideLoading: Promise<PyodideInterface> | null = null;

function post(msg: RuntimeWorkerResponse): void {
  self.postMessage(msg);
}

function lockDownWorkerGlobals(): void {
  const g = globalThis as Record<string, unknown>;
  for (const key of [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'importScripts',
    'indexedDB',
    'caches',
    'BroadcastChannel',
  ]) {
    try {
      Object.defineProperty(g, key, { value: undefined, configurable: false, writable: false });
    } catch {
      // Ignore non-configurable globals
    }
  }
}

const PYTHON_SANDBOX_BOOTSTRAP = `
import json, math, time, sys, traceback

_ALLOWED_IMPORTS = {
    'math', 'random', 'json', 'statistics', 'collections', 'itertools',
    'functools', 'dataclasses', 'enum', 'typing', 're', 'string',
    'numbers', 'decimal', 'fractions'
}

def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split('.')[0]
    if root not in _ALLOWED_IMPORTS:
        raise ImportError(f"Module '{name}' is blocked in the REENTRY flight computer sandbox.")
    return __import__(name, globals, locals, fromlist, level)

_SAFE_BUILTIN_NAMES = [
    'abs', 'all', 'any', 'bool', 'bytes', 'callable', 'chr', 'complex',
    'dict', 'divmod', 'enumerate', 'filter', 'float', 'format', 'frozenset',
    'getattr', 'hasattr', 'hash', 'hex', 'int', 'isinstance', 'issubclass',
    'iter', 'len', 'list', 'map', 'max', 'min', 'next', 'object', 'oct',
    'ord', 'pow', 'range', 'repr', 'reversed', 'round', 'set', 'slice',
    'sorted', 'str', 'sum', 'tuple', 'type', 'zip',
    'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
    'RuntimeError', 'ZeroDivisionError', 'AttributeError', 'StopIteration',
    'AssertionError', 'ArithmeticError', 'LookupError', 'NameError',
]

import builtins as _py_builtins
_SAFE_BUILTINS = {k: getattr(_py_builtins, k) for k in _SAFE_BUILTIN_NAMES if hasattr(_py_builtins, k)}
_SAFE_BUILTINS['__import__'] = _safe_import

class _AttrDict(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(f"Telemetry has no field '{key}'")
    def __setattr__(self, key, value):
        raise TypeError("Telemetry is read-only inside flight programs.")
    def __setitem__(self, key, value):
        raise TypeError("Telemetry is read-only inside flight programs.")

def _wrap_readonly(obj):
    if isinstance(obj, dict):
        d = _AttrDict()
        for k, v in obj.items():
            dict.__setitem__(d, k, _wrap_readonly(v))
        return d
    if isinstance(obj, list):
        return tuple(_wrap_readonly(x) for x in obj)
    return obj

_step_cmd = {}
_step_logs = []
_custom_vars = {}

class _ReentryFlightAPI:
    version = "1.0.0"

    def set_throttle(self, v):
        _step_cmd['throttle'] = v
    setThrottle = set_throttle

    def ignite(self):
        _step_cmd['ignite'] = True

    def shutdown(self):
        _step_cmd['shutdown'] = True

    def set_pitch(self, v):
        _step_cmd['pitch'] = v
    setPitch = set_pitch

    def set_yaw(self, v):
        _step_cmd['yaw'] = v
    setYaw = set_yaw

    def set_roll(self, v):
        _step_cmd['roll'] = v
    setRoll = set_roll

    def set_attitude(self, pitch=None, yaw=None, roll=None):
        if pitch is not None:
            _step_cmd['pitch'] = pitch
        if yaw is not None:
            _step_cmd['yaw'] = yaw
        if roll is not None:
            _step_cmd['roll'] = roll
    setAttitude = set_attitude

    def set_sas_mode(self, mode):
        _step_cmd['sasMode'] = mode
    setSasMode = set_sas_mode

    def set_landing_gear(self, deployed):
        _step_cmd['deployGear'] = deployed
    setLandingGear = set_landing_gear

    def stage(self):
        _step_cmd['stage'] = True

    def log(self, *args):
        if len(_step_logs) < 24:
            _step_logs.append({'level': 'log', 'message': ' '.join(str(a) for a in args)[:400]})

    def warn(self, *args):
        if len(_step_logs) < 24:
            _step_logs.append({'level': 'warn', 'message': ' '.join(str(a) for a in args)[:400]})

    def error(self, *args):
        if len(_step_logs) < 24:
            _step_logs.append({'level': 'error', 'message': ' '.join(str(a) for a in args)[:400]})

    def record(self, key, value):
        k = str(key)[:40]
        if isinstance(value, (bool, int, float, str)):
            if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                return
            if len(_custom_vars) < 32 or k in _custom_vars:
                _custom_vars[k] = value[:80] if isinstance(value, str) else value

_api_instance = _ReentryFlightAPI()
_SAFE_BUILTINS['print'] = _api_instance.log

_user_env = {}

def _run_with_budget(fn, time_limit_ms, max_steps=65000):
    deadline = time.perf_counter() + (time_limit_ms / 1000.0)
    steps = [0]
    def _tracer(frame, event, arg):
        steps[0] += 1
        if steps[0] > max_steps or (steps[0] & 255) == 0 and time.perf_counter() > deadline:
            raise RuntimeError("Execution time / instruction budget exceeded (possible infinite loop).")
        return _tracer
    sys.settrace(_tracer)
    try:
        fn()
    finally:
        sys.settrace(None)

def _extract_user_line(exc):
    tb = exc.__traceback__
    line = None
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == 'flight_program.py':
            line = tb.tb_lineno
        tb = tb.tb_next
    if line is None and isinstance(exc, SyntaxError):
        line = exc.lineno
    return line

def _reentry_load(code_str, telemetry_json, time_limit_ms):
    global _user_env, _step_cmd, _step_logs, _custom_vars
    t0 = time.perf_counter()
    _step_cmd = {}
    _step_logs = []
    _custom_vars = {}
    _user_env = {'__builtins__': _SAFE_BUILTINS, 'api': _api_instance, 'math': math}
    try:
        compiled = compile(code_str, 'flight_program.py', 'exec')
        telem = _wrap_readonly(json.loads(telemetry_json))
        def _do():
            exec(compiled, _user_env)
            init_fn = _user_env.get('init')
            if callable(init_fn):
                try:
                    init_fn(_api_instance, telem)
                except TypeError:
                    init_fn(_api_instance)
        _run_with_budget(_do, time_limit_ms)
        return json.dumps({
            'ok': True, 'command': _step_cmd, 'logs': _step_logs,
            'customVars': _custom_vars, 'execTimeMs': (time.perf_counter() - t0) * 1000.0,
            'memoryBytes': None
        })
    except Exception as e:
        return json.dumps({
            'ok': False, 'command': {}, 'logs': _step_logs,
            'customVars': _custom_vars, 'execTimeMs': (time.perf_counter() - t0) * 1000.0,
            'memoryBytes': None, 'error': f"{type(e).__name__}: {e}", 'line': _extract_user_line(e)
        })

def _reentry_update(telemetry_json, time_limit_ms):
    global _step_cmd, _step_logs
    t0 = time.perf_counter()
    _step_cmd = {}
    _step_logs = []
    try:
        update_fn = _user_env.get('update')
        if callable(update_fn):
            telem = _wrap_readonly(json.loads(telemetry_json))
            _run_with_budget(lambda: update_fn(telem, _api_instance), time_limit_ms)
        return json.dumps({
            'ok': True, 'command': _step_cmd, 'logs': _step_logs,
            'customVars': _custom_vars, 'execTimeMs': (time.perf_counter() - t0) * 1000.0,
            'memoryBytes': None
        })
    except Exception as e:
        return json.dumps({
            'ok': False, 'command': {}, 'logs': _step_logs,
            'customVars': _custom_vars, 'execTimeMs': (time.perf_counter() - t0) * 1000.0,
            'memoryBytes': None, 'error': f"{type(e).__name__}: {e}", 'line': _extract_user_line(e)
        })

def _reentry_event(event_name, payload_json, telemetry_json, time_limit_ms):
    global _step_cmd, _step_logs
    t0 = time.perf_counter()
    _step_cmd = {}
    _step_logs = []
    try:
        ev_fn = _user_env.get('on_event') or _user_env.get('onEvent')
        if callable(ev_fn):
            telem = _wrap_readonly(json.loads(telemetry_json))
            payload = _wrap_readonly(json.loads(payload_json))
            _run_with_budget(lambda: ev_fn(event_name, payload, telem, _api_instance), time_limit_ms)
        return json.dumps({
            'ok': True, 'command': _step_cmd, 'logs': _step_logs,
            'customVars': _custom_vars, 'execTimeMs': (time.perf_counter() - t0) * 1000.0,
            'memoryBytes': None
        })
    except Exception as e:
        return json.dumps({
            'ok': False, 'command': {}, 'logs': _step_logs,
            'customVars': _custom_vars, 'execTimeMs': (time.perf_counter() - t0) * 1000.0,
            'memoryBytes': None, 'error': f"{type(e).__name__}: {e}", 'line': _extract_user_line(e)
        })
`;

async function ensurePyodide(): Promise<PyodideInterface> {
  if (pyodide) return pyodide;
  if (pyodideLoading) return pyodideLoading;

  pyodideLoading = (async () => {
    post({ type: 'status', message: 'Lazy-loading Python runtime (Pyodide WASM)…' });
    const mod = (await import(/* @vite-ignore */ PYODIDE_CDN)) as {
      loadPyodide: (opts: { indexURL: string }) => Promise<PyodideInterface>;
    };
    const instance = await mod.loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.4/full/',
    });
    // Lock down worker network/storage APIs immediately after Pyodide initializes
    lockDownWorkerGlobals();
    instance.runPython(PYTHON_SANDBOX_BOOTSTRAP);
    post({ type: 'status', message: 'Python sandbox ready (restricted capabilities active).' });
    pyodide = instance;
    return instance;
  })();

  return pyodideLoading;
}

self.onmessage = async (ev: MessageEvent<RuntimeWorkerRequest>) => {
  const req = ev.data;
  try {
    const py = await ensurePyodide();
    let jsonOut: string;

    if (req.type === 'load') {
      py.globals.set('_arg_code', req.code);
      py.globals.set('_arg_telem', JSON.stringify(req.telemetry));
      py.globals.set('_arg_limit', req.timeLimitMs);
      jsonOut = String(py.runPython('_reentry_load(_arg_code, _arg_telem, _arg_limit)'));
    } else if (req.type === 'update') {
      py.globals.set('_arg_telem', JSON.stringify(req.telemetry));
      py.globals.set('_arg_limit', req.timeLimitMs);
      jsonOut = String(py.runPython('_reentry_update(_arg_telem, _arg_limit)'));
    } else {
      py.globals.set('_arg_ev', req.eventName);
      py.globals.set('_arg_payload', JSON.stringify(req.payload));
      py.globals.set('_arg_telem', JSON.stringify(req.telemetry));
      py.globals.set('_arg_limit', req.timeLimitMs);
      jsonOut = String(py.runPython('_reentry_event(_arg_ev, _arg_payload, _arg_telem, _arg_limit)'));
    }

    const result = JSON.parse(jsonOut) as ProgramStepResult;
    post({ type: 'result', requestId: req.requestId, result });
  } catch (err) {
    post({
      type: 'result',
      requestId: req.requestId,
      result: {
        ok: false,
        command: {},
        logs: [],
        customVars: {},
        execTimeMs: 0,
        memoryBytes: null,
        error: `Python runtime error: ${err instanceof Error ? err.message : String(err)}`,
        line: null,
      },
    });
  }
};

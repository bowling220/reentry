import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Keep package resolution inside the project; delete only the directory we create.
const directory = await mkdtemp(join(process.cwd(), '.reentry-tests-'));
try {
  const output = join(directory, 'simulation.mjs');
  await build({ entryPoints: ['tests/simulation.test.ts'], outfile: output,
    platform: 'node', format: 'esm', bundle: true, packages: 'external' });
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}

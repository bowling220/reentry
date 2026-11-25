import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Keep package resolution inside the project; delete only the directory we create.
const directory = await mkdtemp(join(process.cwd(), '.reentry-tests-'));
try {
  const simOut = join(directory, 'simulation.mjs');
  const fcOut = join(directory, 'flightComputer.mjs');
  const demoOut = join(directory, 'demoPrograms.mjs');
  await Promise.all([
    build({ entryPoints: ['tests/demoPrograms.test.ts'], outfile: demoOut, platform: 'node', format: 'esm', bundle: true, packages: 'external' }),
    build({
      entryPoints: ['tests/simulation.test.ts'],
      outfile: simOut,
      platform: 'node',
      format: 'esm',
      bundle: true,
      packages: 'external',
    }),
    build({
      entryPoints: ['tests/flightComputer.test.ts'],
      outfile: fcOut,
      platform: 'node',
      format: 'esm',
      bundle: true,
      packages: 'external',
    }),
  ]);
  const result = spawnSync(process.execPath, ['--test', simOut, fcOut, demoOut], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}

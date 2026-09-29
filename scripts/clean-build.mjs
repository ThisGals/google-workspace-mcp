#!/usr/bin/env node
/**
 * Cross-platform stand-ins for the `rm -rf build` and `cp -r` steps of `npm run build`.
 *
 * npm runs scripts through cmd.exe on Windows, which has neither command. That did not
 * matter while the package was only built on CI and on maintainers' machines, but
 * installing from git (`npx github:owner/repo#ref`) runs `prepare`, and so the build,
 * on the INSTALLING machine, whatever it is.
 *
 *   node scripts/clean-build.mjs clean   remove build/
 *   node scripts/clean-build.mjs assets  copy the non-TypeScript files tsc does not emit
 */
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => resolve(ROOT, p);

const step = process.argv[2];
if (step === 'clean') {
  rmSync(at('build'), { recursive: true, force: true });
} else if (step === 'assets') {
  cpSync(at('src/factory/manifest'), at('build/factory/manifest'), { recursive: true });
  cpSync(at('src/google/descriptor.json'), at('build/google/descriptor.json'));
} else {
  console.error(`clean-build: unknown step '${step}' (expected 'clean' or 'assets')`);
  process.exit(1);
}

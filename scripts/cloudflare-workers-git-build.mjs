#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const pnpmVersion = process.env.CLOUD_MAIL_PNPM_VERSION || '10.11.1';

function ensurePath(path, label) {
  if (!existsSync(path)) {
    console.error(`[cloud-mail-build] Missing ${label}: ${path}`);
    process.exit(1);
  }
}

function run(args) {
  console.log(`[cloud-mail-build] npx ${args.join(' ')}`);
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npx', ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit'
  });

  if (result.error) {
    console.error(`[cloud-mail-build] Failed to run npx: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const workerDir = join(repoRoot, 'mail-worker');
const vueDir = join(repoRoot, 'mail-vue');

ensurePath(join(workerDir, 'package.json'), 'mail-worker/package.json');
ensurePath(join(vueDir, 'package.json'), 'mail-vue/package.json');

run([`pnpm@${pnpmVersion}`, '--prefix', workerDir, 'install', '--frozen-lockfile']);
run([`pnpm@${pnpmVersion}`, '--prefix', vueDir, 'install', '--frozen-lockfile']);
run([`pnpm@${pnpmVersion}`, '--prefix', vueDir, 'run', 'build']);

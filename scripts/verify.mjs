#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const vueDir = join(repoRoot, 'mail-vue')
const workerDir = resolve(process.env.CLOUD_MAIL_WORKER_TEST_DIR || join(repoRoot, 'mail-worker'))
const executableSuffix = process.platform === 'win32' ? '.cmd' : ''

function localExecutable(projectDir, name) {
  return join(projectDir, 'node_modules', '.bin', `${name}${executableSuffix}`)
}

const frontendTests = readdirSync(join(vueDir, 'test'))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join('test', name))

const steps = [
  {
    id: 'release-config-tests',
    cwd: repoRoot,
    command: process.execPath,
    args: ['--test', join('scripts', 'verify-release.test.mjs')]
  },
  {
    id: 'worker-tests',
    cwd: workerDir,
    command: localExecutable(workerDir, 'vitest'),
    args: ['run', '--no-file-parallelism', '--maxWorkers=1']
  },
  {
    id: 'frontend-tests',
    cwd: vueDir,
    command: process.execPath,
    args: ['--test', ...frontendTests]
  },
  {
    id: 'frontend-release-build',
    cwd: vueDir,
    command: localExecutable(vueDir, 'vite'),
    args: ['build', '--mode', 'release']
  }
]

// Deploy and CI verify the same source commit. --deploy is a compatible alias, not a test bypass.
const selectedSteps = steps

if (process.argv.includes('--dry-run')) {
  process.stdout.write(`${JSON.stringify(selectedSteps.map(step => ({
    id: step.id,
    cwd: relative(repoRoot, step.cwd),
    command: relative(repoRoot, step.command),
    args: step.args
  })), null, 2)}\n`)
  process.exit(0)
}

// Every execution, including --deploy, runs all release gates.

for (const step of selectedSteps) {
  if (!existsSync(step.command)) {
    console.error(`[verify] Missing executable for ${step.id}: ${step.command}`)
    process.exit(1)
  }

  console.log(`[verify] ${step.id}`)
  const command = process.platform === 'win32' && step.command.endsWith('.cmd')
    ? 'cmd.exe'
    : step.command
  const args = command === 'cmd.exe'
    ? ['/d', '/s', '/c', step.command, ...step.args]
    : step.args
  const result = spawnSync(command, args, {
    cwd: step.cwd,
    stdio: 'inherit'
  })

  if (result.error) {
    console.error(`[verify] ${step.id} failed to start: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('the shared release command gates Worker tests, frontend tests, and the release build', () => {
  const result = spawnSync(process.execPath, ['scripts/verify.mjs', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  const steps = JSON.parse(result.stdout)
  assert.deepEqual(steps.map(step => step.id), [
    'release-config-tests',
    'worker-tests',
    'frontend-tests',
    'frontend-release-build'
  ])
})

test('deploying cannot bypass worker or frontend tests', () => {
  const result = spawnSync(process.execPath, ['scripts/verify.mjs', '--deploy', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })

  assert.equal(result.status, 0, result.stderr)
  const steps = JSON.parse(result.stdout)
  assert.deepEqual(steps.map(step => step.id), [
    'release-config-tests',
    'worker-tests',
    'frontend-tests',
    'frontend-release-build'
  ])
})

test('pull requests and main pushes run the full release gate, not the deploy subset', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')

  assert.match(workflow, /pull_request:/)
  assert.match(workflow, /push:/)
  assert.match(workflow, /node scripts\/cloudflare-workers-git-build\.mjs/)
  // 部署路径把单元测试交给了这条工作流，所以它绝不能也退化成 --deploy 子集
  assert.doesNotMatch(workflow, /cloudflare-workers-git-build\.mjs --deploy/)
})

test('the legacy manual deployment verifies the release before invoking Wrangler deploy', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-cloudflare.yml'), 'utf8')
  const gateIndex = workflow.indexOf('node scripts/cloudflare-workers-git-build.mjs')
  const deployIndex = workflow.indexOf('pnpm wrangler deploy')

  assert.ok(gateIndex >= 0, 'manual deployment is missing the shared release gate')
  assert.ok(gateIndex < deployIndex, 'manual deployment reaches Wrangler before verification')
  // 这条工作流是人工触发的一次性部署，等得起全量门禁，不该退化成 --deploy 子集
  assert.doesNotMatch(workflow, /cloudflare-workers-git-build\.mjs --deploy/)
})

test('the legacy D1 provisioner uses D1_DATABASE_NAME instead of the Worker name', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-cloudflare.yml'), 'utf8')
  const start = workflow.indexOf('Set up D1 database')
  const end = workflow.indexOf('Start deployment', start)
  const d1Step = workflow.slice(start, end)

  assert.ok(start >= 0 && end > start, 'D1 provisioning step was not found')
  assert.match(d1Step, /\$D1_DATABASE_NAME/)
  assert.doesNotMatch(d1Step, /\$NAME\b/)
})

test('the legacy workflow serializes CORS origins as a validated array', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-cloudflare.yml'), 'utf8')
  const template = readFileSync(resolve(repoRoot, 'mail-worker/wrangler-action.toml'), 'utf8')

  assert.match(workflow, /CORS_ORIGINS:.*\|\| '\[\]'/)
  assert.match(workflow, /jq -e[^\n]+\$CORS_ORIGINS/)
  assert.match(template, /^cors_origins = \$\{CORS_ORIGINS\}$/m)
})

test('the legacy workflow does not retain deployment logs, expose URL outputs, or erase audit history', () => {
  const workflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy-cloudflare.yml'), 'utf8')

  assert.doesNotMatch(workflow, /deploy\.log/)
  assert.doesNotMatch(workflow, /worker_url/)
  assert.doesNotMatch(workflow, /delete-workflow-runs/)
  assert.match(workflow, /<redacted-url>/)
})

test('Cloudflare Git deployment output redacts generated deployment URLs', async () => {
  const { redactDeploymentOutput } = await import('./deployment-output.mjs')

  assert.equal(
    redactDeploymentOutput('deployed to https://cloud-mail.example.workers.dev\n'),
    'deployed to <redacted-url>\n'
  )
})

test('every supported Wrangler entry point sends static pages through the Worker', () => {
  const rootConfig = JSON.parse(readFileSync(resolve(repoRoot, 'wrangler.jsonc'), 'utf8'))
  const tomlConfigs = [
    'wrangler.toml',
    'wrangler-dev.toml',
    'wrangler-test.toml',
    'wrangler-action.toml'
  ].map(name => readFileSync(resolve(repoRoot, 'mail-worker', name), 'utf8'))

  assert.equal(rootConfig.assets.run_worker_first, true)
  for (const config of tomlConfigs) {
    assert.match(config, /^run_worker_first = true(?:\s|$)/m)
  }
})

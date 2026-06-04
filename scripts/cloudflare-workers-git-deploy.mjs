#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const generatedDir = join(repoRoot, '.wrangler');
const generatedConfig = join(generatedDir, 'cloud-mail.generated.wrangler.jsonc');

const env = process.env;
const workerName = env.NAME || 'cloud-mail';
const wranglerVersion = env.CLOUD_MAIL_WRANGLER_VERSION || '4.92.0';

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isTrue(value) {
  return String(value || '').toLowerCase() === 'true';
}

const d1Database = {
  binding: 'db',
  database_name: optionalString(env.D1_DATABASE_NAME) || 'mail'
};

if (optionalString(env.D1_DATABASE_ID)) {
  d1Database.database_id = optionalString(env.D1_DATABASE_ID);
} else {
  console.warn('[cloud-mail-deploy] D1_DATABASE_ID is not set; using database_name-only D1 binding.');
}

const kvNamespace = {
  binding: 'kv'
};

if (optionalString(env.KV_NAMESPACE_ID)) {
  kvNamespace.id = optionalString(env.KV_NAMESPACE_ID);
} else {
  console.warn('[cloud-mail-deploy] KV_NAMESPACE_ID is not set; using binding-only KV namespace.');
}

const config = {
  name: workerName,
  main: '../mail-worker/src/index.js',
  compatibility_date: '2025-06-04',
  keep_vars: true,
  workers_dev: true,
  preview_urls: true,
  observability: {
    enabled: true
  },
  d1_databases: [d1Database],
  kv_namespaces: [kvNamespace],
  ai: {
    binding: 'ai'
  },
  assets: {
    binding: 'assets',
    directory: '../mail-worker/dist',
    not_found_handling: 'single-page-application',
    run_worker_first: true
  },
  triggers: {
    crons: ['*/30 * * * *', '0 16 * * *']
  },
  build: {
    command: 'node scripts/cloudflare-workers-git-build.mjs'
  }
};

if (optionalString(env.CUSTOM_DOMAIN)) {
  config.routes = [
    {
      pattern: optionalString(env.CUSTOM_DOMAIN),
      custom_domain: true
    }
  ];
}

if (optionalString(env.R2_BUCKET_NAME)) {
  config.r2_buckets = [
    {
      binding: 'r2',
      bucket_name: optionalString(env.R2_BUCKET_NAME)
    }
  ];
}

if (isTrue(env.CF_EMAIL)) {
  config.send_email = [
    {
      name: 'email'
    }
  ];
}

mkdirSync(generatedDir, { recursive: true });
writeFileSync(generatedConfig, `${JSON.stringify(config, null, 2)}\n`);

console.log(`[cloud-mail-deploy] Generated Wrangler config: ${generatedConfig}`);
console.log('[cloud-mail-deploy] Runtime variables are preserved by keep_vars=true; configure secrets in Cloudflare variables/secrets.');

const deployArgs = [`wrangler@${wranglerVersion}`, 'deploy', '--config', generatedConfig];

if (isTrue(env.CLOUD_MAIL_DEPLOY_DRY_RUN)) {
  deployArgs.push('--dry-run');
}

const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npx', ...deployArgs] : deployArgs;
const result = spawnSync(command, commandArgs, {
  cwd: repoRoot,
  stdio: 'inherit'
});

if (result.error) {
  console.error(`[cloud-mail-deploy] Failed to run npx: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status || 0);

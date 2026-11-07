// Static files are served straight from the assets layer (free and outside the Workers request quota);
// page navigations, /api, /static and /attachments still run the Worker so documents keep its CSP headers.
// wrangler.jsonc and every mail-worker/wrangler*.toml must list exactly these patterns.
export const RUN_WORKER_FIRST = Object.freeze([
  '/*',
  '!/assets/*',
  '!/tinymce/*',
  '!/image/*',
  '!/theme-bootstrap.js',
  '!/mail.png',
  '!/mail-pwa.png',
  '!/manifest.webmanifest',
  '!/registerSW.js',
  '!/sw.js'
])

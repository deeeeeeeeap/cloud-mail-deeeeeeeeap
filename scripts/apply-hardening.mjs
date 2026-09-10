// Temporary, explicit source transformations for the isolated review branch.
// Every replacement asserts the reviewed baseline; never deploys or contacts data services.
import { readFileSync, writeFileSync } from 'node:fs';
function replace(path, before, after) {
  const text = readFileSync(path, 'utf8');
  if (text.includes(after)) return;
  if (text.split(before).length !== 2) throw new Error(`Expected exactly one audited match: ${path}: ${before.slice(0, 100)}`);
  writeFileSync(path, text.replace(before, after));
}
function transform(path, fn) {
  const before = readFileSync(path, 'utf8');
  writeFileSync(path, fn(before));
}

replace('mail-worker/src/index.js',
  "\t\t\tconst key = url.pathname.substring(1);\n\t\t\tif (!await attService.isPublicInlineKey({ env }, key)) {\n\t\t\t\treturn withSecurityHeaders(new Response('Not found', { status: 404 }));\n\t\t\t}\n\t\t\tresponse = await objectResponse({ env }, key);\n\t\t\treturn withSecurityHeaders(response);",
  "\t\t\t// Private mail resources must never be served by an anonymous object URL.\n\t\t\treturn withSecurityHeaders(new Response('Not found', {\n\t\t\t\tstatus: 404, headers: { 'Cache-Control': 'private, no-store' }\n\t\t\t}));");
replace('mail-worker/src/index.js', "import attService from './service/att-service';\n", '// Inline attachments are served exclusively through authenticated API routes.\n');
for (const [file, prefix, user, options] of [
  ['mail-worker/src/api/email-api.js', '/email', 'userContext.getUserId(c)', ''],
  ['mail-worker/src/api/all-email-api.js', '/allEmail', 'undefined', ', { allMail: true }']
]) {
  replace(file, "import app from '../hono/hono';", "import app from '../hono/hono';\nimport { inlineAttachmentResponse } from '../service/inline-attachment-service';");
  const route = `\napp.get('${prefix}/attachment/inline', async (c) => {\n\treturn inlineAttachmentResponse(c, c.req.query(), ${user}${options});\n});\n`;
  transform(file, text => text.includes(route) ? text : text + route);
}
replace('mail-worker/src/security/security.js', "\t'/allEmail/attachment/download',", "\t'/allEmail/attachment/download',\n\t'/allEmail/attachment/inline',");
replace('mail-worker/src/security/security.js', "'/allEmail/detail','/allEmail/attachment/download',", "'/allEmail/detail','/allEmail/attachment/download','/allEmail/attachment/inline',");
replace('mail-worker/src/service/att-service.js',
  "\t\t\tfilters.push('a.user_id = ?');\n\t\t\tbindings.push(userId);",
  "\t\t\tfilters.push('a.user_id = ?', 'e.user_id = ?', 'e.is_del = 0');\n\t\t\tbindings.push(userId, userId);");

const view = 'mail-vue/src/views/content/index.vue';
replace(view, ':html="formatImage(email.content)"', ':html="email.content" :email-id="email.emailId" :scope="emailStore.contentData.delType === \'physics\' ? \'all\' : \'user\'"');
replace(view, 'const email = reactive(createEmailDetailView(sourceEmail))', "const email = reactive(createEmailDetailView({ attList: [], recipient: '[]', ...sourceEmail }))");
replace(view, "return  message ? JSON.parse(message).message : '';", "if (!message) return '';\n  try { return JSON.parse(message).message || String(message); } catch { return String(message); }");
replace(view, "  recipient = JSON.parse(recipient)\n  return recipient.map(item => item.address).join(', ')", "  try {\n    const list = typeof recipient === 'string' ? JSON.parse(recipient) : recipient;\n    return Array.isArray(list) ? list.map(item => item?.address || '').filter(Boolean).join(', ') : '';\n  } catch { return ''; }");

const store = 'mail-vue/src/store/email.js';
replace(store, "import { defineStore } from 'pinia'", "import { defineStore } from 'pinia'\nimport { safeEmailCache, deserializeEmailCache } from '@/utils/email-cache.js'");
replace(store, "        pick: ['contentData'],", "        pick: ['contentData'],\n        // Rewrite legacy caches after sanitizing them during hydration.\n        afterHydrate: ({ store }) => store.$persist(),");
replace(store,
  "            // 正文 HTML/纯文本不落 localStorage，详情页 onMounted 会重新拉取\n            serialize: (state) => {\n                const contentData = { ...state.contentData };\n                if (contentData.email) {\n                    const { content, text, ...rest } = contentData.email;\n                    contentData.email = rest;\n                }\n                return JSON.stringify({ contentData });\n            },\n            deserialize: JSON.parse,",
  "            serialize: (state) => JSON.stringify(safeEmailCache(state)),\n            deserialize: deserializeEmailCache,");

const verify = 'scripts/verify.mjs';
transform(verify, text => {
  if (text.includes('// Deploy and CI verify the same source commit.')) return text;
  const start = text.indexOf('// 部署只需要产出 dist');
  const end = text.indexOf("if (process.argv.includes('--dry-run'))", start);
  if (start < 0 || end < 0) throw new Error('Release gate baseline changed');
  return text.slice(0, start) + '// Deploy and CI verify the same source commit. --deploy is a compatible alias, not a test bypass.\nconst selectedSteps = steps\n\n' + text.slice(end);
});
replace(verify, "if (deployOnly) {\n  console.log('[verify] deploy mode: skipping unit tests, they run in CI')\n}", "// Every execution, including --deploy, runs all release gates.");
replace('scripts/cloudflare-workers-git-build.mjs', "'[cloud-mail-build] Building release artifacts (unit tests run in CI).'", "'[cloud-mail-build] Running full verification before building deployment artifacts.'");
replace('scripts/verify-release.test.mjs', "test('deploying skips the unit tests but still checks config and builds the assets'", "test('deploying cannot bypass worker or frontend tests'");
replace('scripts/verify-release.test.mjs', "    'release-config-tests',\n    'frontend-release-build'", "    'release-config-tests',\n    'worker-tests',\n    'frontend-tests',\n    'frontend-release-build'");
console.log('Applied reviewed mail-reader, attachment, cache and release-gate changes.');

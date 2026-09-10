const fs = require('node:fs');
const { createHash } = require('node:crypto');
const hash = s => createHash('sha256').update(s).digest('hex');
function reviewedEdit(path, beforeHash, afterHash, edit) {
  const source = fs.readFileSync(path, 'utf8');
  if (hash(source) !== beforeHash) throw new Error(`Review baseline changed: ${path}`);
  const updated = edit(source);
  if (hash(updated) !== afterHash) throw new Error(`Review result changed: ${path}`);
  fs.writeFileSync(path, updated);
}
reviewedEdit('mail-vue/src/layout/write/index.vue',
  '9e94d4e7f76dd6d98956604467447fd47e2ac1d0db8859dce64d288ef9ba06f8',
  '594cf31d7aa809a453a113f2294ada4aad9573053062304679d7cdde40606b3d',
  s => s.replace('      height: 100dvh;\n      padding-bottom: max(16px, env(safe-area-inset-bottom));\n      border-radius: 0;\n      border: 0;\n      padding: 16px;',
                 '      height: 100dvh;\n      border-radius: 0;\n      border: 0;\n      padding: 16px;\n      padding-bottom: max(16px, env(safe-area-inset-bottom));'));
reviewedEdit('mail-vue/test/frontend-ux.test.mjs',
  '592a8edbd910af0a49736d02d9f2cb51fd129b565f4b255975c9e5976530bc3d',
  '57bf2de26958a666d434882765b4fc82c14d9cab3156473e1f921f1371e5ae00',
  s => s + "\n// A later padding shorthand must not silently erase the phone's safe-area inset.\ntest('mobile writer retains bottom safe-area padding after its base padding', () => {\n  const writer = readFileSync(new URL('../src/layout/write/index.vue', import.meta.url), 'utf8')\n  assert.match(writer, /height: 100dvh;\\s+border-radius: 0;\\s+border: 0;\\s+padding: 16px;\\s+padding-bottom: max\\(16px, env\\(safe-area-inset-bottom\\)\\);/)\n})\n");
console.log('Applied final safe-area review correction and regression test.');

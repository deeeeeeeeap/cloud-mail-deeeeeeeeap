// Temporary source transfer for this review branch only. No network or data-service access.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gunzipSync } = require('node:zlib');
const hash = data => createHash('sha256').update(data).digest('hex');
const encoded = Array.from({length: 6}, (_, i) => fs.readFileSync(`.github/frontend-ux-transfer-${i + 1}.b64`, 'utf8').trim()).join('');
const bytes = gunzipSync(Buffer.from(encoded, 'base64'));
if (hash(bytes) !== '6e5a9449bea4c1d791392a2710fc8d4d3ebf590abb3db1161273cbac270086bc') throw new Error('Source bundle checksum mismatch');
const records = JSON.parse(bytes.toString('utf8'));
if (!Array.isArray(records) || records.length !== 21) throw new Error('Unexpected file count');
const seen = new Set();
const prepared = records.map(record => {
  const p = record.path;
  if (typeof p !== 'string' || path.posix.normalize(p) !== p || p.includes('..') || (!p.startsWith('mail-vue/') && p !== 'doc/frontend-ux-20260910.md') || seen.has(p)) throw new Error('Unexpected source path');
  seen.add(p);
  if (record.before === null && fs.existsSync(p)) throw new Error(`New path already exists: ${p}`);
  let data = record.before === null ? Buffer.alloc(0) : fs.readFileSync(p);
  if (record.before !== null && hash(data) !== record.before) throw new Error(`Baseline changed: ${p}`);
  let lastEnd = 0;
  for (const edit of record.edits) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < lastEnd || edit.end < edit.start || edit.end > data.length || typeof edit.text !== 'string') throw new Error(`Invalid byte edit: ${p}`);
    lastEnd = edit.end;
  }
  for (const edit of [...record.edits].reverse()) data = Buffer.concat([data.subarray(0, edit.start), Buffer.from(edit.text, 'utf8'), data.subarray(edit.end)]);
  if (hash(data) !== record.after) throw new Error(`Final source checksum mismatch: ${p}`);
  return { path: p, data };
});
// Validate every file before writing any file; offsets above are bytes, not UTF-16 units.
for (const entry of prepared) {
  fs.mkdirSync(path.dirname(entry.path), {recursive: true});
  fs.writeFileSync(entry.path, entry.data);
}
console.log(`Applied ${prepared.length} reviewed source files; baseline and final SHA-256 verified.`);

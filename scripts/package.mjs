import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
for (const target of ['server', 'host', 'app']) {
  const metadata = JSON.parse(await readFile(`dist/${target}.meta.json`, 'utf8'));
  if (metadata.pluginVersion !== manifest.version || metadata.pluginId !== 'account-limits') throw new Error(`Stale ${target} bundle; run npm run build`);
}
// BB's virtual Zod source-map entry includes the build checkout path. Relocate
// map references before distribution; executable bundles and their digests stay intact.
const checkout = resolve('.').replaceAll('\\', '/');
for (const target of ['server', 'host']) {
  const path = `dist/${target}.js.map`;
  const map = JSON.parse(await readFile(path, 'utf8'));
  map.sources = map.sources.map(source => source.replaceAll('\\', '/').replaceAll(checkout, '..'));
  if (typeof map.sourceRoot === 'string') map.sourceRoot = map.sourceRoot.replaceAll('\\', '/').replaceAll(checkout, '..');
  await writeFile(path, JSON.stringify(map) + '\n');
}
await mkdir('release', { recursive: true });
const packResult = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', 'release'], { encoding: 'utf8' }));
// npm versions return either an array or a package-name keyed object.
const packed = Array.isArray(packResult) ? packResult : Object.values(packResult);
if (packed.length !== 1) throw new Error('Expected exactly one archive');
const artifact = packed[0];
const names = new Set(artifact.files.map(file => file.path));
for (const file of ['package.json', 'server.ts', 'host.ts', 'app.tsx', 'dist/server.js', 'dist/host.js', 'dist/app.js', 'dist/app.meta.json', 'icons/account-limits.svg', 'LICENSE']) {
  if (!names.has(file)) throw new Error(`Archive is missing ${file}`);
}
for (const name of names) {
  if (name.includes('..') || /(^|\/)(node_modules|\.git|release)\//u.test(name) || /(?:\.test\.[^/]+|\.local\.json|\.key|\.env)$/u.test(name)) throw new Error(`Unexpected archive path: ${name}`);
}
const bytes = await readFile(resolve('release', artifact.filename));
const sha256 = createHash('sha256').update(bytes).digest('hex');
let commit = null;
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source tarballs need no Git checkout. */ }
await writeFile('release/SHA256SUMS', `${sha256}  ${artifact.filename}\n`);
await writeFile('release/release-manifest.json', JSON.stringify({ version: manifest.version, commit, artifact: artifact.filename, bytes: bytes.length, sha256, files: [...names].sort() }, null, 2) + '\n');
console.log(JSON.stringify({ artifact: `release/${artifact.filename}`, bytes: bytes.length, sha256 }));

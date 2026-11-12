// Prepare only the verified installable files for the public Release.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function preparePublicRelease({ source, destination, version }) {
  assert.match(version, /^\d+\.\d+\.\d+-baidu\.[1-9]\d*$/, 'Invalid fork version.');
  source = resolve(source);
  destination = resolve(destination);
  assert.notEqual(source, destination);
  const receipt = JSON.parse(readFileSync(join(source, 'VALIDATION.json'), 'utf8'));
  assert.equal(receipt.schema, 2);
  assert.equal(receipt.success, true);
  assert.equal(receipt.version, version);
  const corePrefix = `sing-box-${version.replace(/\.\d+$/, '.')}`;
  const matchers = [
    { match: n => n === `SFW-${version}-x64.exe`, target: `SFW-${version}-x64.exe` },
    { match: n => n === `SFA-Baidu-${version}-arm64-v8a.apk`, target: `SFA-Baidu-${version}-arm64-v8a.apk` },
    ...['windows-amd64.zip', 'android-arm64.tar.gz', 'linux-amd64.tar.gz'].map(suffix => ({
      match: n => n.startsWith(corePrefix) && n.endsWith(`-${suffix}`),
      target: `sing-box-${version}-${suffix}`,
    })),
  ];
  assert(Array.isArray(receipt.artifacts));
  mkdirSync(destination, { recursive: true });
  assert.equal(readdirSync(destination).length, 0, 'Public release directory must be empty.');
  for (const { match, target } of matchers) {
    const found = receipt.artifacts.filter(item => typeof item.filename === 'string' && match(item.filename));
    assert.equal(found.length, 1, `Expected exactly one verified asset for ${target}.`);
    const artifact = found[0];
    assert.equal(basename(artifact.filename), artifact.filename);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    const file = join(source, artifact.filename);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), artifact.sha256, `Asset changed: ${artifact.filename}`);
    copyFileSync(file, join(destination, target));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 5, 'Usage: baidu-public-release.mjs SOURCE DESTINATION VERSION');
    preparePublicRelease({ source: process.argv[2], destination: process.argv[3], version: process.argv[4] });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePublicRelease } from './baidu-public-release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'baidu-public-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'verified'), destination = join(root, 'public');
  mkdirSync(source);
  const version = '1.14.4-baidu.12345';
  const filenames = [
    `SFW-${version}-x64.exe`, `SFA-Baidu-${version}-arm64-v8a.apk`,
    'sing-box-1.14.4-baidu.abcdef123456-windows-amd64.zip',
    'sing-box-1.14.4-baidu.abcdef123456-android-arm64.tar.gz',
    'sing-box-1.14.4-baidu.abcdef123456-linux-amd64.tar.gz',
    'ANDROID-VALIDATION.json', 'SFA-version-metadata.json',
  ];
  const artifacts = filenames.map(filename => {
    const content = `verified ${filename}`;
    writeFileSync(join(source, filename), content);
    return { filename, sha256: createHash('sha256').update(content).digest('hex') };
  });
  writeFileSync(join(source, 'VALIDATION.json'), JSON.stringify({ schema: 2, success: true, version, artifacts }));
  return { source, destination, version, filenames };
}

test('publish only five verified installers and core archives with one version', t => {
  const f = fixture(t);
  preparePublicRelease(f);
  assert.deepEqual(readdirSync(f.destination).sort(), [
    `SFA-Baidu-${f.version}-arm64-v8a.apk`, `SFW-${f.version}-x64.exe`,
    ...['android-arm64.tar.gz', 'linux-amd64.tar.gz', 'windows-amd64.zip'].map(suffix => `sing-box-${f.version}-${suffix}`),
  ].sort());
});

test('a changed asset cannot be prepared for publication', t => {
  const f = fixture(t);
  writeFileSync(join(f.source, f.filenames[0]), 'changed');
  assert.throws(() => preparePublicRelease(f), /Asset changed/);
});

test('duplicate matching assets cannot be prepared for publication', t => {
  const f = fixture(t);
  const path = join(f.source, 'VALIDATION.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  receipt.artifacts.push(receipt.artifacts[0]);
  writeFileSync(path, JSON.stringify(receipt));
  assert.throws(() => preparePublicRelease(f), /exactly one verified asset/);
});

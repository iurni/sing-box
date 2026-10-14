#!/usr/bin/env node
// Transfer one exact candidate to all builders and join their independent gates.
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stableParts, TARGET_BRANCH, VERSION_FILE } from './baidu-sync.mjs';

export const REQUIRED_TARGETS = ['linux/amd64', 'windows/amd64', 'android/arm64', 'windows/amd64-gui', 'android/arm64-v8a'];
export const REQUIRED_CHECKS = ['sync-fixtures', 'pipeline-fixtures', 'root-go-tests', 'baidu-race-tests', 'config-smoke', 'e2e-loopback', 'windows-client-signed', 'android-client-signed'];
const CORE_CHECKS = REQUIRED_CHECKS.slice(0, 6);
const WINDOWS_CHECKS = ['pinned-sfw-source', 'fork-update-source', 'isolated-installation', 'source-built-baidu-daemon', 'amd64-pe', 'matching-authenticode-signatures', 'installer-product'];
const ANDROID_CHECKS = ['official-pinned-client', 'official-client-go-toolchain', 'custom-libbox-built-from-core', 'apk-assembly', 'apk-signature', 'package-id', 'version-metadata', 'arm64-v8a-only', 'elf64-aarch64-libbox', 'baidu-core-provenance'];
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const git = (cwd, ...args) => run('git', args, cwd);
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJSON = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
function output(values) {
  for (const [key, value] of Object.entries(values)) {
    assert(!/[\r\n]/.test(String(value)), 'Multiline workflow output is forbidden.');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify(values));
}
function source(cwd) {
  assert.equal(git(cwd, 'status', '--porcelain'), '', 'Source checkout must be clean.');
  const upstreamTag = readFileSync(join(cwd, VERSION_FILE), 'utf8').trim();
  stableParts(upstreamTag);
  return { head: git(cwd, 'rev-parse', 'HEAD'), tree: git(cwd, 'rev-parse', 'HEAD^{tree}'), upstreamTag };
}
function identity(receipt, expected) {
  assert.equal(receipt.schema, 1, 'Unsupported builder receipt schema.');
  assert.equal(receipt.success, true, 'A builder did not pass its checks.');
  for (const name of ['head', 'tree', 'upstreamTag']) assert.equal(receipt[name], expected[name], `Builder ${name} differs from the candidate.`);
}
function safeArtifact(item) {
  assert.equal(basename(item.filename), item.filename, 'An artifact filename must not contain a path.');
  assert.match(item.filename, /^[A-Za-z0-9][A-Za-z0-9.+_-]*\.(?:exe|apk|zip|tar\.gz|json)$/);
  assert.match(item.sha256, /^[a-f0-9]{64}$/);
}
function checkFiles(directory, receipt, { allowMetadata = false } = {}) {
  assert(Array.isArray(receipt.artifacts) && receipt.artifacts.length, 'Builder artifact list is empty.');
  const seen = new Set();
  for (const artifact of receipt.artifacts) {
    safeArtifact(artifact);
    assert(!seen.has(artifact.filename), 'Duplicate artifact filename.');
    seen.add(artifact.filename);
    assert.equal(sha(join(directory, artifact.filename)), artifact.sha256, `Changed artifact: ${artifact.filename}`);
  }
  const recognized = new Set([...seen, 'VALIDATION.json', 'ANDROID-VALIDATION.json', 'WINDOWS-VALIDATION.json', 'SHA256SUMS']);
  for (const filename of readdirSync(directory)) {
    assert(recognized.has(filename) || (allowMetadata && /^SFA-[A-Za-z0-9.+_-]+-metadata\.json$/.test(filename)), `Unexpected builder file: ${filename}`);
  }
}

export function exportCandidate({ cwd = process.cwd(), directory, runId = process.env.GITHUB_RUN_ID, now = Date.now() } = {}) {
  cwd = resolve(cwd); directory = resolve(directory);
  assert.match(String(runId), /^[1-9]\d*$/, 'A numeric workflow run ID is required.');
  const info = source(cwd);
  const gitDir = git(cwd, 'rev-parse', '--absolute-git-dir');
  const stateFile = join(gitDir, 'baidu-sync-state.json');
  const syncState = existsSync(stateFile) ? readJSON(stateFile) : null;
  if (syncState) {
    assert.equal(syncState.schema, 1);
    assert.equal(syncState.branch, TARGET_BRANCH);
    assert.equal(syncState.mergeCommit, info.head);
    assert.equal(syncState.tag, info.upstreamTag);
  }
  const versionCode = Math.floor(now / 1000);
  assert(versionCode > 0 && versionCode <= 2147483647, 'Android version code exceeds the signed integer range.');
  mkdirSync(directory, { recursive: true });
  const bundlePath = join(directory, 'candidate.bundle');
  rmSync(bundlePath, { force: true });
  // A full bundle is independent of the runner's shallow checkout and includes
  // the candidate's complete ancestry, including an unpushed stable merge.
  git(cwd, 'bundle', 'create', bundlePath, 'HEAD');
  const metadata = { schema: 1, ...info, runId: String(runId),
    appVersion: `${info.upstreamTag.slice(1)}-baidu.${runId}`, versionCode,
    bundleSHA256: sha(bundlePath), syncState };
  writeJSON(join(directory, 'CANDIDATE.json'), metadata);
  output({ source_sha: info.head, upstream_tag: info.upstreamTag, app_version: metadata.appVersion, version_code: versionCode });
  return metadata;
}

export function importCandidate({ cwd = process.cwd(), directory, expectedHead, expectedRunId } = {}) {
  cwd = resolve(cwd); directory = resolve(directory);
  const metadata = readJSON(join(directory, 'CANDIDATE.json'));
  assert.equal(metadata.schema, 1);
  assert.match(metadata.head, /^[a-f0-9]{40}$/);
  assert.match(metadata.tree, /^[a-f0-9]{40}$/);
  stableParts(metadata.upstreamTag);
  if (expectedHead) assert.equal(metadata.head, expectedHead, 'Downloaded candidate differs from the preparation job.');
  if (expectedRunId) assert.equal(metadata.runId, String(expectedRunId), 'Candidate is from another workflow run.');
  const bundlePath = join(directory, 'candidate.bundle');
  assert.equal(sha(bundlePath), metadata.bundleSHA256, 'Candidate bundle changed after preparation.');
  assert.equal(git(cwd, 'status', '--porcelain'), '', 'Import requires a clean checkout.');
  git(cwd, 'bundle', 'verify', bundlePath);
  git(cwd, 'fetch', '--no-tags', bundlePath, 'HEAD');
  assert.equal(git(cwd, 'rev-parse', 'FETCH_HEAD'), metadata.head);
  if (metadata.syncState) {
    assert.equal(metadata.syncState.branch, TARGET_BRANCH);
    assert.equal(metadata.syncState.mergeCommit, metadata.head);
    assert.match(metadata.syncState.candidate, /^codex\/baidu-sync\/v\d+\.\d+\.\d+-[a-f0-9]{12}$/);
    git(cwd, 'switch', '-C', metadata.syncState.candidate, metadata.head);
  } else git(cwd, 'checkout', '--detach', metadata.head);
  const actual = source(cwd);
  for (const name of ['head', 'tree', 'upstreamTag']) assert.equal(actual[name], metadata[name]);
  const gitDir = git(cwd, 'rev-parse', '--absolute-git-dir');
  const stateFile = join(gitDir, 'baidu-sync-state.json');
  if (metadata.syncState) writeJSON(stateFile, metadata.syncState);
  else rmSync(stateFile, { force: true });
  rmSync(join(gitDir, 'baidu-validation.json'), { force: true });
  writeJSON(join(gitDir, 'baidu-candidate.json'), metadata);
  return metadata;
}

export function collectRelease({ cwd = process.cwd(), coreDirectory, windowsDirectory, androidDirectory, directory,
  windowsFingerprint = process.env.BAIDU_WINDOWS_CERT_SHA256, androidFingerprint = process.env.BAIDU_ANDROID_CERT_SHA256 } = {}) {
  cwd = resolve(cwd); directory = resolve(directory);
  const expected = source(cwd);
  const core = readJSON(join(coreDirectory, 'VALIDATION.json'));
  const windows = readJSON(join(windowsDirectory, 'WINDOWS-VALIDATION.json'));
  const android = readJSON(join(androidDirectory, 'ANDROID-VALIDATION.json'));
  for (const receipt of [core, windows, android]) identity(receipt, expected);
  const candidate = readJSON(join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'baidu-candidate.json'));
  assert.equal(candidate.head, expected.head);
  assert.equal(windows.version, candidate.appVersion);
  assert.equal(android.version, candidate.appVersion);
  assert.equal(android.versionCode, candidate.versionCode);
  assert.equal(windows.appSource, git(cwd, 'ls-tree', 'HEAD', 'clients/desktop').split(/\s+/)[2], 'Windows client differs from the stable source gitlink.');
  assert.equal(android.appSource, git(cwd, 'ls-tree', 'HEAD', 'clients/android').split(/\s+/)[2], 'Android client differs from the stable source gitlink.');
  assert.match(windows.appSource, /^[a-f0-9]{40}$/);
  assert.match(android.appSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(windows.checks, WINDOWS_CHECKS);
  assert.deepEqual(android.checks, ANDROID_CHECKS);
  // The Android builder verifies GOVERSION against version.properties from
  // this exact client gitlink. Client Git objects are not in the core bundle,
  // so collection must not fetch a floating client ref to repeat that check.
  assert.match(android.goVersion || '', /^(?:[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, 'Android receipt must record the verified stable Go toolchain.');
  assert.deepEqual(core.targets, REQUIRED_TARGETS.slice(0, 3));
  assert.deepEqual(core.checks, CORE_CHECKS);
  assert.equal(core.artifacts.length, 3);
  for (const [receipt, target, fingerprint, extension] of [
    [windows, 'windows/amd64-gui', windowsFingerprint, '.exe'],
    [android, 'android/arm64-v8a', androidFingerprint, '.apk'],
  ]) {
    assert.equal(receipt.target, target);
    assert.equal(receipt.coreContainsBaidu, true, 'The client must contain the custom Baidu core.');
    assert.match(fingerprint || '', /^[a-fA-F0-9]{64}$/, 'Pinned signing certificate fingerprint is required.');
    assert.equal(receipt.signerSHA256.toLowerCase(), fingerprint.toLowerCase(), 'Client signing certificate changed.');
    assert(receipt.artifacts.some(item => item.filename.endsWith(extension)), `Missing ${extension} installer.`);
  }
  checkFiles(coreDirectory, core);
  checkFiles(windowsDirectory, windows);
  checkFiles(androidDirectory, android, { allowMetadata: true });
  mkdirSync(directory, { recursive: true });
  assert.equal(readdirSync(directory).length, 0, 'Release staging directory must be empty.');
  const artifacts = [], seen = new Set();
  for (const [origin, receipt, receiptName] of [
    [coreDirectory, core, 'CORE-VALIDATION.json'],
    [windowsDirectory, windows, 'WINDOWS-VALIDATION.json'],
    [androidDirectory, android, 'ANDROID-VALIDATION.json'],
  ]) {
    for (const artifact of receipt.artifacts) {
      assert(!seen.has(artifact.filename), 'Artifact filename collides across builders.');
      seen.add(artifact.filename);
      copyFileSync(join(origin, artifact.filename), join(directory, artifact.filename));
      artifacts.push(artifact);
    }
    writeJSON(join(directory, receiptName), receipt);
    artifacts.push({ filename: receiptName, sha256: sha(join(directory, receiptName)) });
  }
  const receipt = { schema: 2, success: true, ...expected, version: candidate.appVersion,
    targets: REQUIRED_TARGETS, checks: REQUIRED_CHECKS, artifacts,
    clientSigners: { windows: windows.signerSHA256, android: android.signerSHA256 },
    clientSources: { windows: windows.appSource, android: android.appSource } };
  writeJSON(join(directory, 'VALIDATION.json'), receipt);
  writeFileSync(join(directory, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.filename}\n`).join(''));
  writeJSON(join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'baidu-validation.json'), receipt);
  verifyRelease({ cwd, directory });
  return receipt;
}

export function verifyRelease({ cwd = process.cwd(), directory } = {}) {
  cwd = resolve(cwd); directory = resolve(directory);
  const receipt = readJSON(join(directory, 'VALIDATION.json'));
  assert.equal(receipt.schema, 2, 'GUI and APK receipts are required for publication.');
  assert.equal(receipt.success, true);
  const expected = source(cwd);
  for (const name of ['head', 'tree', 'upstreamTag']) assert.equal(receipt[name], expected[name], 'Release differs from validated source.');
  assert.deepEqual(receipt.targets, REQUIRED_TARGETS);
  assert.deepEqual(receipt.checks, REQUIRED_CHECKS);
  const filenames = new Set();
  for (const item of receipt.artifacts) {
    safeArtifact(item);
    assert(!filenames.has(item.filename), 'Duplicate release artifact.'); filenames.add(item.filename);
    assert.equal(sha(join(directory, item.filename)), item.sha256, `Changed release artifact: ${item.filename}`);
  }
  assert([...filenames].some(name => name.startsWith('SFW-') && name.endsWith('.exe')));
  assert([...filenames].some(name => name.startsWith('SFA-') && name.endsWith('.apk')));
  for (const name of ['CORE-VALIDATION.json', 'WINDOWS-VALIDATION.json', 'ANDROID-VALIDATION.json']) assert(filenames.has(name));
  assert.deepEqual(readdirSync(directory).sort(), [...filenames, 'VALIDATION.json', 'SHA256SUMS'].sort());
  assert.equal(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'), receipt.artifacts.map(item => `${item.sha256}  ${item.filename}\n`).join(''));
  output({ upstream_tag: receipt.upstreamTag, commit: receipt.head });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      assert(args[index].startsWith('--') && args[index + 1], 'Expected option/value pair.');
      const key = args[index].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = args[index + 1];
    }
    const operations = { export: exportCandidate, import: importCandidate, collect: collectRelease, verify: verifyRelease };
    assert(operations[operation], 'Unknown pipeline operation.');
    operations[operation](options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

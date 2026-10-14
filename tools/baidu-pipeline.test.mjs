import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportCandidate, importCandidate, collectRelease, verifyRelease, REQUIRED_TARGETS, REQUIRED_CHECKS } from './baidu-pipeline.mjs';
import { prepare } from './baidu-sync.mjs';

const windowsFingerprint = 'a'.repeat(64), androidFingerprint = 'b'.repeat(64);
const desktopCommit = 'd'.repeat(40), androidCommit = 'e'.repeat(40);
function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function writeJSON(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'baidu-pipeline-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-b', 'codex/baidu');
  git(repo, 'config', 'user.name', 'Pipeline fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, '.github'));
  writeFileSync(join(repo, '.gitignore'), '/dist/\n');
  writeFileSync(join(repo, '.github/baidu-upstream-version'), 'v1.0.0\n');
  writeFileSync(join(repo, 'core.txt'), 'one source\n');
  git(repo, 'add', '.');
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${desktopCommit},clients/desktop`);
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${androidCommit},clients/android`);
  // Uninitialized submodule directories keep fixture status clean.
  mkdirSync(join(repo, 'clients/desktop'), { recursive: true });
  mkdirSync(join(repo, 'clients/android'), { recursive: true });
  git(repo, 'commit', '-m', 'Fixture stable source');
  git(repo, 'tag', 'v1.0.0');
  return { root, repo, head: git(repo, 'rev-parse', 'HEAD'), tree: git(repo, 'rev-parse', 'HEAD^{tree}') };
}
function transfer(f) {
  const directory = join(f.root, 'transfer');
  const metadata = exportCandidate({ cwd: f.repo, directory, runId: '123', now: 1800000000000 });
  writeJSON(join(git(f.repo, 'rev-parse', '--absolute-git-dir'), 'baidu-candidate.json'), metadata);
  return { directory, metadata };
}
function artifacts(directory, filenames) {
  mkdirSync(directory, { recursive: true });
  return filenames.map(filename => {
    const bytes = Buffer.from(`fixture checked installer ${filename}`);
    writeFileSync(join(directory, filename), bytes);
    return { filename, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}
function packages(f) {
  transfer(f);
  const common = { schema: 1, success: true, head: f.head, tree: f.tree, upstreamTag: 'v1.0.0' };
  const version = '1.0.0-baidu.123';
  const coreDirectory = join(f.root, 'core'), windowsDirectory = join(f.root, 'windows'), androidDirectory = join(f.root, 'android');
  const core = { ...common, version: `1.0.0-baidu.${f.head.slice(0, 12)}`, targets: REQUIRED_TARGETS.slice(0, 3), checks: REQUIRED_CHECKS.slice(0, 6),
    artifacts: artifacts(coreDirectory, ['sing-box-1.0.0-baidu.fixture-linux-amd64.tar.gz', 'sing-box-1.0.0-baidu.fixture-windows-amd64.zip', 'sing-box-1.0.0-baidu.fixture-android-arm64.tar.gz']) };
  const windows = { ...common, version, appSource: desktopCommit, target: 'windows/amd64-gui', signerSHA256: windowsFingerprint, coreContainsBaidu: true,
    checks: ['pinned-sfw-source', 'fork-update-source', 'isolated-installation', 'source-built-baidu-daemon', 'amd64-pe', 'matching-authenticode-signatures', 'installer-product'],
    artifacts: artifacts(windowsDirectory, [`SFW-${version}-x64.exe`]) };
  const android = { ...common, version, versionCode: 1800000000, appSource: androidCommit, target: 'android/arm64-v8a', signerSHA256: androidFingerprint, coreContainsBaidu: true,
    checks: ['official-pinned-client', 'custom-libbox-built-from-core', 'apk-assembly', 'apk-signature', 'package-id', 'version-metadata', 'arm64-v8a-only', 'elf64-aarch64-libbox', 'baidu-core-provenance'],
    artifacts: artifacts(androidDirectory, [`SFA-Baidu-${version}-arm64-v8a.apk`, 'SFA-version-metadata.json']) };
  writeJSON(join(coreDirectory, 'VALIDATION.json'), core);
  writeJSON(join(windowsDirectory, 'WINDOWS-VALIDATION.json'), windows);
  writeJSON(join(androidDirectory, 'ANDROID-VALIDATION.json'), android);
  return { coreDirectory, windowsDirectory, androidDirectory, core, windows, android,
    cwd: f.repo, directory: join(f.root, 'release'), windowsFingerprint, androidFingerprint };
}

test('a full candidate bundle imports exactly the prepared commit and tree on another runner', t => {
  const f = fixture(t), exported = transfer(f), runner = join(f.root, 'runner');
  git(f.root, 'clone', '--no-checkout', f.repo, runner);
  git(runner, 'checkout', '--detach', f.head);
  const actual = importCandidate({ cwd: runner, directory: exported.directory, expectedHead: f.head, expectedRunId: '123' });
  assert.equal(actual.tree, f.tree);
  assert.equal(git(runner, 'rev-parse', 'HEAD'), f.head);
  assert.equal(git(runner, 'status', '--porcelain'), '');
  assert.throws(() => importCandidate({ cwd: runner, directory: exported.directory, expectedHead: '0'.repeat(40) }), /preparation job/);
  assert.throws(() => importCandidate({ cwd: runner, directory: exported.directory, expectedRunId: '124' }), /another workflow/);
});

test('candidate transfer rejects tampered bundle bytes before fetching or modifying the builder', t => {
  const f = fixture(t), exported = transfer(f);
  writeFileSync(join(exported.directory, 'candidate.bundle'), 'tampered');
  assert.throws(() => importCandidate({ cwd: f.repo, directory: exported.directory, expectedHead: f.head }), /bundle changed/);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.head);
});

test('an unpushed stable candidate and its state reach a builder without changing the original branch', t => {
  const f = fixture(t), runner = join(f.root, 'runner'), upstream = join(f.root, 'upstream');
  git(f.root, 'clone', f.repo, runner);
  git(f.root, 'clone', f.repo, upstream);
  git(upstream, 'config', 'user.name', 'Upstream fixture');
  git(upstream, 'config', 'user.email', 'upstream@example.invalid');
  writeFileSync(join(upstream, 'stable.txt'), 'new official stable\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'Stable update'); git(upstream, 'tag', 'v1.0.1');
  const state = prepare({ cwd: f.repo, tag: 'v1.0.1', upstream });
  assert.equal(git(f.repo, 'rev-parse', 'codex/baidu'), f.head);
  const directory = join(f.root, 'candidate');
  const metadata = exportCandidate({ cwd: f.repo, directory, runId: '123', now: 1800000000000 });
  assert.equal(metadata.syncState.mergeCommit, state.mergeCommit);
  importCandidate({ cwd: runner, directory, expectedHead: state.mergeCommit, expectedRunId: '123' });
  assert.equal(git(runner, 'rev-parse', 'HEAD'), state.mergeCommit);
  assert.equal(git(runner, 'branch', '--show-current'), state.candidate);
  assert.equal(git(runner, 'rev-parse', 'codex/baidu'), f.head);
  assert.equal(JSON.parse(readFileSync(join(git(runner, 'rev-parse', '--absolute-git-dir'), 'baidu-sync-state.json'), 'utf8')).base, f.head);
});

test('one failed app, a core-only build, or a receipt from another source cannot produce publication approval', t => {
  const f = fixture(t), p = packages(f);
  writeJSON(join(p.androidDirectory, 'ANDROID-VALIDATION.json'), { ...p.android, success: false });
  assert.throws(() => collectRelease(p), /did not pass/);
  writeJSON(join(p.androidDirectory, 'ANDROID-VALIDATION.json'), { ...p.android, head: 'f'.repeat(40) });
  assert.throws(() => collectRelease(p), /head differs/);
  writeJSON(join(p.androidDirectory, 'ANDROID-VALIDATION.json'), p.android);
  writeJSON(join(p.windowsDirectory, 'WINDOWS-VALIDATION.json'), { ...p.windows, coreContainsBaidu: false });
  assert.throws(() => collectRelease(p), /custom Baidu core/);
  assert.throws(() => verifyRelease({ cwd: f.repo, directory: p.coreDirectory }), /GUI and APK/);
});

test('pinned client commits, signing identities, build checks, versions and artifact bytes are publication gates', t => {
  const f = fixture(t), p = packages(f);
  for (const change of [{ appSource: 'f'.repeat(40) }, { signerSHA256: 'c'.repeat(64) }, { checks: [] }, { version: '1.0.0-baidu.124' }]) {
    writeJSON(join(p.windowsDirectory, 'WINDOWS-VALIDATION.json'), { ...p.windows, ...change });
    assert.throws(() => collectRelease(p));
  }
  writeJSON(join(p.windowsDirectory, 'WINDOWS-VALIDATION.json'), p.windows);
  writeFileSync(join(p.androidDirectory, p.android.artifacts[0].filename), 'changed APK');
  assert.throws(() => collectRelease(p), /Changed artifact/);
});

test('a complete consistent source set produces checksums and schema2 and detects later release corruption', t => {
  const f = fixture(t), p = packages(f);
  const receipt = collectRelease(p);
  assert.equal(receipt.schema, 2);
  assert.deepEqual(receipt.targets, REQUIRED_TARGETS);
  assert.deepEqual(receipt.checks, REQUIRED_CHECKS);
  assert.equal(receipt.head, f.head);
  assert.equal(verifyRelease({ cwd: f.repo, directory: p.directory }).head, f.head);
  writeFileSync(join(p.directory, p.windows.artifacts[0].filename), 'changed release installer');
  assert.throws(() => verifyRelease({ cwd: f.repo, directory: p.directory }), /Changed release artifact/);
});

test('Android version codes reject integer overflow and extra release files are rejected', t => {
  const f = fixture(t);
  assert.throws(() => exportCandidate({ cwd: f.repo, directory: join(f.root, 'overflow'), runId: '123', now: 2147483648000 }), /signed integer/);
  const p = packages(f); collectRelease(p);
  writeFileSync(join(p.directory, 'unexpected-secret.txt'), 'fixture only');
  assert.throws(() => verifyRelease({ cwd: f.repo, directory: p.directory }));
});

test('both public entry workflows require the reusable all-app pipeline, and publication depends on all builders', () => {
  for (const file of ['baidu-build.yml', 'baidu-sync.yml']) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    assert(workflow.includes('uses: ./.github/workflows/baidu-apps.yml'));
  }
  const workflow = readFileSync(new URL('../.github/workflows/baidu-apps.yml', import.meta.url), 'utf8');
  assert(workflow.includes('needs: [prepare, core, android, windows]'));
  const publication = workflow.slice(workflow.indexOf('\n  publish:'));
  assert(!publication.includes('if: always()'));
  assert(workflow.indexOf('Retain the complete verified app release artifact') < workflow.indexOf('node tools/baidu-sync.mjs --publish'));
  assert(publication.includes('node tools/baidu-pipeline.mjs collect'));
  assert(publication.includes('test "$remote_head" = "$EXPECTED_HEAD"'));
  assert(workflow.match(/github\.event_name != 'pull_request'/g).length >= 3);
});

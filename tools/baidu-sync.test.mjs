import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareTags, latestStableTag, prepare, publish, VERSION_FILE } from './baidu-sync.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function identity(cwd) {
  git(cwd, 'config', 'user.name', 'Baidu sync fixture');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  git(cwd, 'config', 'core.autocrlf', 'false');
}
function write(cwd, file, text) { writeFileSync(join(cwd, file), text); }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sing-box-baidu-sync-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = join(root, 'upstream'), custom = join(root, 'custom'), remote = join(root, 'remote.git');
  mkdirSync(upstream);
  git(upstream, 'init', '-b', 'stable');
  identity(upstream);
  write(upstream, 'upstream.txt', 'release zero\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'Initial upstream');
  git(upstream, 'tag', 'v1.0.0');
  git(root, 'clone', upstream, custom);
  identity(custom);
  git(custom, 'switch', '-c', 'codex/baidu');
  mkdirSync(join(custom, '.github'));
  write(custom, VERSION_FILE, 'v1.0.0\n');
  write(custom, 'baidu.txt', 'custom protocol\n');
  git(custom, 'add', '.');
  git(custom, 'commit', '-m', 'Custom protocol');
  git(root, 'init', '--bare', remote);
  git(custom, 'remote', 'set-url', 'origin', remote);
  git(custom, 'push', '-u', 'origin', 'codex/baidu');
  return { root, upstream, custom, remote, base: git(custom, 'rev-parse', 'HEAD') };
}
function nextRelease(f, { conflict = false, tag = 'v1.0.1' } = {}) {
  if (conflict) {
    write(f.custom, 'upstream.txt', 'custom side\n');
    git(f.custom, 'add', '.');
    git(f.custom, 'commit', '-m', 'Custom edit');
    git(f.custom, 'push', 'origin', 'codex/baidu');
    f.base = git(f.custom, 'rev-parse', 'HEAD');
  }
  write(f.upstream, 'upstream.txt', 'next stable\n');
  git(f.upstream, 'add', '.');
  git(f.upstream, 'commit', '-m', 'Next upstream');
  git(f.upstream, 'tag', tag);
}
function remoteHead(f) { return git(f.custom, 'ls-remote', 'origin', 'refs/heads/codex/baidu').split(/\s+/)[0]; }
function candidate(f) { return prepare({ cwd: f.custom, upstream: f.upstream, tag: 'v1.0.1' }); }
function receipt(f, state, change = {}) {
  // Stand in for baidu-build.mjs's receipt to exercise publication invariants.
  const gitDir = git(f.custom, 'rev-parse', '--absolute-git-dir');
  writeFileSync(join(gitDir, 'baidu-validation.json'), JSON.stringify({
    schema: 1, success: true, head: state.mergeCommit, tree: git(f.custom, 'write-tree'),
    upstreamTag: state.tag, targets: ['linux/amd64', 'windows/amd64', 'android/arm64'],
    checks: ['sync-fixtures', 'root-go-tests', 'baidu-race-tests', 'config-smoke', 'e2e-loopback'], ...change,
  }));
}

test('only non-draft exact stable releases participate, in numeric version order', () => {
  assert.equal(latestStableTag([
    [{ tag_name: 'v1.9.9', draft: false, prerelease: false }, { tag_name: 'v1.10.2', draft: false, prerelease: false }],
    [{ tag_name: 'v2.0.0-alpha.1', prerelease: true }, { tag_name: 'v3.0.0', draft: true },
      { tag_name: 'v2.0.0', prerelease: true }, { tag_name: 'nightly', prerelease: false }],
  ]), 'v1.10.2');
  assert(compareTags('v1.10.0', 'v1.9.99') > 0);
  assert.throws(() => latestStableTag([{ tag_name: 'nightly' }]), /no stable/);
  assert.throws(() => compareTags('v1.2.3-beta.1', 'v1.2.3'), /stable release/);
});

test('already-current releases do not change the branch or remote', t => {
  const f = fixture(t);
  assert.equal(prepare({ cwd: f.custom, upstream: f.upstream, tag: 'v1.0.0' }).changed, false);
  assert.equal(git(f.custom, 'rev-parse', 'HEAD'), f.base);
  assert.equal(remoteHead(f), f.base);
});

test('dry-run fetches official history but does not edit or merge the checkout', t => {
  const f = fixture(t); nextRelease(f);
  assert.equal(prepare({ cwd: f.custom, upstream: f.upstream, tag: 'v1.0.1', dryRun: true }).changed, true);
  assert.equal(git(f.custom, 'branch', '--show-current'), 'codex/baidu');
  assert.equal(git(f.custom, 'rev-parse', 'HEAD'), f.base);
  assert.equal(readFileSync(join(f.custom, VERSION_FILE), 'utf8'), 'v1.0.0\n');
  assert.equal(git(f.custom, 'status', '--porcelain'), '');
  assert.equal(remoteHead(f), f.base);
});

test('prepare preserves custom code and keeps baidu and the remote unchanged', t => {
  const f = fixture(t); nextRelease(f);
  const state = candidate(f);
  assert.equal(git(f.custom, 'branch', '--show-current'), state.candidate);
  assert.equal(git(f.custom, 'rev-parse', 'codex/baidu'), f.base);
  assert.equal(remoteHead(f), f.base);
  assert.equal(readFileSync(join(f.custom, 'baidu.txt'), 'utf8'), 'custom protocol\n');
  assert.equal(readFileSync(join(f.custom, 'upstream.txt'), 'utf8'), 'next stable\n');
  assert.equal(readFileSync(join(f.custom, VERSION_FILE), 'utf8'), 'v1.0.1\n');
});

test('merge conflicts abort and restore the original custom checkout', t => {
  const f = fixture(t); nextRelease(f, { conflict: true });
  assert.throws(() => candidate(f), /failed/);
  assert.equal(git(f.custom, 'branch', '--show-current'), 'codex/baidu');
  assert.equal(git(f.custom, 'rev-parse', 'HEAD'), f.base);
  assert.equal(git(f.custom, 'status', '--porcelain'), '');
  assert.equal(remoteHead(f), f.base);
});

test('a stable minor release from a parallel upstream branch still merges shared history', t => {
  const f = fixture(t);
  write(f.upstream, 'old-patch.txt', 'patch release\n');
  git(f.upstream, 'add', '.'); git(f.upstream, 'commit', '-m', 'Old stable patch'); git(f.upstream, 'tag', 'v1.0.1');
  git(f.custom, 'fetch', '--no-tags', f.upstream, 'refs/tags/v1.0.1');
  git(f.custom, 'merge', '--no-ff', '--no-edit', 'FETCH_HEAD');
  write(f.custom, VERSION_FILE, 'v1.0.1\n');
  git(f.custom, 'add', VERSION_FILE); git(f.custom, 'commit', '-m', 'Track old stable patch');
  git(f.custom, 'push', 'origin', 'codex/baidu');
  f.base = git(f.custom, 'rev-parse', 'HEAD');
  git(f.upstream, 'switch', '-c', 'next-minor', 'v1.0.0');
  write(f.upstream, 'new-minor.txt', 'next minor\n');
  git(f.upstream, 'add', '.'); git(f.upstream, 'commit', '-m', 'New minor'); git(f.upstream, 'tag', 'v1.1.0');
  const state = prepare({ cwd: f.custom, upstream: f.upstream, tag: 'v1.1.0' });
  assert.equal(state.previous, 'v1.0.1');
  assert.equal(state.tag, 'v1.1.0');
  assert.equal(readFileSync(join(f.custom, 'new-minor.txt'), 'utf8'), 'next minor\n');
  assert.equal(readFileSync(join(f.custom, 'baidu.txt'), 'utf8'), 'custom protocol\n');
  assert.equal(remoteHead(f), f.base);
});

test('a failed or skipped validation cannot publish', t => {
  const f = fixture(t); nextRelease(f);
  const state = candidate(f);
  assert.throws(() => publish({ cwd: f.custom }), /successful validation receipt/);
  receipt(f, state, { success: false });
  assert.throws(() => publish({ cwd: f.custom }), /Invalid sync state/);
  assert.equal(remoteHead(f), f.base);
});

test('an incomplete build matrix cannot publish', t => {
  const f = fixture(t); nextRelease(f);
  const state = candidate(f);
  receipt(f, state, { targets: ['windows/amd64'] });
  assert.throws(() => publish({ cwd: f.custom }), /every required check/);
  assert.equal(remoteHead(f), f.base);
});

test('source edits after validation cannot publish', t => {
  const f = fixture(t); nextRelease(f);
  const state = candidate(f); receipt(f, state);
  write(f.custom, 'baidu.txt', 'changed after test\n');
  assert.throws(() => publish({ cwd: f.custom }), /Only the staged/);
  assert.equal(remoteHead(f), f.base);
});

test('staged edits after validation cannot publish', t => {
  const f = fixture(t); nextRelease(f);
  const state = candidate(f); receipt(f, state);
  write(f.custom, 'baidu.txt', 'changed after test\n');
  git(f.custom, 'add', 'baidu.txt');
  assert.throws(() => publish({ cwd: f.custom }), /changed after validation/);
  assert.equal(remoteHead(f), f.base);
});

test('a concurrent human push stops publication rather than overwriting it', t => {
  const f = fixture(t); nextRelease(f);
  const state = candidate(f); receipt(f, state);
  const human = join(f.root, 'human');
  git(f.root, 'clone', '-b', 'codex/baidu', f.remote, human); identity(human);
  write(human, 'human.txt', 'preserve this\n');
  git(human, 'add', '.'); git(human, 'commit', '-m', 'Human changes'); git(human, 'push', 'origin', 'codex/baidu');
  const humanHead = remoteHead(f);
  assert.throws(() => publish({ cwd: f.custom }), /advanced while checks ran/);
  assert.equal(remoteHead(f), humanHead);
});

test('a complete matching validation publishes a normal merge without losing custom code', t => {
  const f = fixture(t); nextRelease(f);
  const state = candidate(f); receipt(f, state);
  publish({ cwd: f.custom });
  const published = remoteHead(f);
  assert.notEqual(published, f.base);
  git(f.custom, 'merge-base', '--is-ancestor', f.base, published);
  assert.equal(git(f.custom, 'show', `${published}:baidu.txt`), 'custom protocol');
  assert.equal(git(f.custom, 'show', `${published}:${VERSION_FILE}`), 'v1.0.1');
});

test('dirty or wrong-branch local checkouts stop before preparing a merge', t => {
  const f = fixture(t); nextRelease(f);
  write(f.custom, 'baidu.txt', 'unsaved work\n');
  assert.throws(() => candidate(f), /dirty/);
  assert.equal(remoteHead(f), f.base);
  git(f.custom, 'restore', 'baidu.txt');
  git(f.custom, 'switch', 'stable');
  assert.throws(() => candidate(f), /baidu branch/);
});

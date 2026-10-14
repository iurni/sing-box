#!/usr/bin/env node
// Validation and small, source-built release artifacts. This never contacts a Baidu endpoint.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stableParts, VERSION_FILE } from './baidu-sync.mjs';

const cwd = process.cwd();
// Follow upstream's non-Naive build feature set as each stable release changes it.
const tags = readFileSync('release/DEFAULT_BUILD_TAGS_OTHERS', 'utf8').trim();
function run(command, args, extraEnv = {}, capture = false) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, ...extraEnv }, encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}). ${result.stderr || ''}`);
  return (result.stdout || '').trim();
}
function git(...args) { return run('git', args, {}, true); }
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }

try {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error('Use a Linux amd64 host (the GitHub Actions Ubuntu runner) for this validation/build script.');
  if (process.argv.length !== 2) throw new Error('Build script accepts no unchecked target or tag overrides.');
  const gitDir = git('rev-parse', '--absolute-git-dir');
  const receiptPath = join(gitDir, 'baidu-validation.json');
  rmSync(receiptPath, { force: true });
  const statePath = join(gitDir, 'baidu-sync-state.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  const upstreamTag = readFileSync(VERSION_FILE, 'utf8').trim();
  stableParts(upstreamTag);
  if (git('status', '--porcelain')) throw new Error('Validation requires a clean committed checkout.');
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  if (state && (state.mergeCommit !== head || state.tag !== upstreamTag))
    throw new Error('Sync state does not match this candidate checkout.');
  if (!readdirSync('protocol/baidu').some(name => name.endsWith('_test.go')))
    throw new Error('Baidu protocol regression tests are missing.');
  const version = `${upstreamTag.slice(1)}-baidu.${head.slice(0, 12)}`;
  const sharedFlags = readFileSync('release/LDFLAGS', 'utf8').trim();
  const ldflags = `-X github.com/sagernet/sing-box/constant.Version=${version} ${sharedFlags} -s -w -buildid=`;
  const goHost = { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '1', GOTOOLCHAIN: 'local' };

  run(process.execPath, ['--test', 'tools/baidu-sync.test.mjs']);
  run(process.execPath, ['--test', 'tools/baidu-pipeline.test.mjs']);
  // Same root-module coverage as upstream .github/workflows/test.yml. The separate
  // test/ module needs Docker/services and is deliberately outside this small CI.
  const rootArgs = ['test', '-v', '-count=1', '-timeout=15m', '-exec', 'sudo', '-tags', tags, '-ldflags', sharedFlags, './...'];
  run('go', rootArgs, goHost);
  run('go', ['test', '-race', '-count=1', '-timeout=5m', '-tags', tags, '-ldflags', sharedFlags, './protocol/baidu'], goHost);

  const buildRoot = resolve('dist/baidu');
  const packageRoot = resolve('dist/baidu-packages');
  mkdirSync(buildRoot, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  const targets = [
    { os: 'linux', arch: 'amd64', binary: 'sing-box' },
    { os: 'windows', arch: 'amd64', binary: 'sing-box.exe' },
    { os: 'android', arch: 'arm64', binary: 'sing-box' },
  ];
  const artifacts = [];
  for (const target of targets) {
    const directoryName = `sing-box-${version}-${target.os}-${target.arch}`;
    const directory = join(buildRoot, directoryName);
    mkdirSync(directory, { recursive: true });
    const binary = join(directory, target.binary);
    run('go', ['build', '-trimpath', '-tags', tags, '-ldflags', ldflags, '-o', binary, './cmd/sing-box'], {
      GOOS: target.os, GOARCH: target.arch, CGO_ENABLED: '0', GOTOOLCHAIN: 'local',
    });
    if (target.os === 'linux') {
      run(binary, ['version']);
      // check constructs the custom outbound against a loopback dummy address;
      // it does not start TUN or dial a real proxy/target.
      run(binary, ['check', '-c', '.github/baidu-smoke.json']);
      run(process.execPath, ['tools/baidu-e2e.mjs', binary]);
    }
    copyFileSync('LICENSE', join(directory, 'LICENSE'));
    writeFileSync(join(directory, 'BUILD-INFO.json'), `${JSON.stringify({
      version, upstream_tag: upstreamTag, source_commit: head, validated_tree: tree,
      go: run('go', ['version'], {}, true), goos: target.os, goarch: target.arch,
      cgo_enabled: false, build_tags: tags.split(','),
      description: 'Custom Baidu TCP outbound; source-built, no credentials included.',
    }, null, 2)}\n`);
    const filename = `${directoryName}.${target.os === 'windows' ? 'zip' : 'tar.gz'}`;
    const archive = join(packageRoot, filename);
    rmSync(archive, { force: true });
    if (target.os === 'windows') {
      const result = spawnSync('zip', ['-q', '-r', archive, directoryName], { cwd: buildRoot, stdio: 'inherit' });
      if (result.error || result.status !== 0) throw result.error || new Error('Windows ZIP packaging failed.');
    } else run('tar', ['-czf', archive, '-C', buildRoot, directoryName]);
    artifacts.push({ filename, sha256: sha256(archive) });
  }
  if (git('rev-parse', 'HEAD') !== head || git('rev-parse', 'HEAD^{tree}') !== tree || git('status', '--porcelain'))
    throw new Error('Tracked sources changed during validation; no success receipt was written.');
  writeFileSync(join(packageRoot, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.filename}\n`).join(''));
  const receipt = { schema: 1, success: true, head, tree, upstreamTag, version,
    checks: ['sync-fixtures', 'pipeline-fixtures', 'root-go-tests', 'baidu-race-tests', 'config-smoke', 'e2e-loopback'],
    targets: targets.map(target => `${target.os}/${target.arch}`), artifacts };
  writeFileSync(join(packageRoot, 'VALIDATION.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`Validated ${version}; Windows amd64, Android arm64, and Linux amd64 packages are in dist/baidu-packages.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

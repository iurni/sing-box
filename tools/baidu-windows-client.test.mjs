import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { assertClientOverlayPaths, executableContentDigest, planWindowsPatches, portableExecutableMachine, validateChangedSourceScope } from './baidu-windows-client.mjs';

const root = resolve(import.meta.dirname, '..');

test('pinned SFW preparation isolates service, storage, IPC, updates, and product without removing signature checks', () => {
  if (!existsSync(join(root, 'clients/desktop/version.json'))) {
    throw new Error('Initialize the pinned desktop submodule to run client preparation tests.');
  }
  const patches = planWindowsPatches(root, '1.14.3-baidu.123');
  const after = file => patches.get(file).after;
  assert(after('clients/desktop/electron-builder.yml').includes('forceCodeSigning: true'));
  assert(after('clients/desktop/electron-builder.yml').includes('productName: sing-box Baidu'));
  assert(after('clients/desktop/src/main/updates.ts').includes('/repos/iurni/sing-box/releases'));
  assert(!after('clients/desktop/src/main/updates.ts').includes('/repos/SagerNet/sing-box/releases'));
  assert(after('experimental/boxdd/main.go').includes('const serviceName = "sing-box-baidu-daemon"'));
  assert(after('experimental/boxdd/server_windows.go').includes('Administrators\\sing-box-baidu`'));
  assert(after('clients/desktop/src/main/daemon.ts').includes('Administrators\\\\sing-box-baidu"'));
  assert(after('experimental/boxdd/peer_windows.go').includes('sing-box Baidu.exe'));
  assert(after('experimental/boxdd/peer_windows.go').includes('authenticodeSigner'));
  assert(after('clients/desktop/src/main/worker.ts').includes('sing-box-baidu-worker.'));
  assert(after('clients/desktop/src/main/index.ts').includes('"sing-box-baidu:"'));
  assert(after('clients/desktop/src/main/installationLayout.ts').includes('SOFTWARE\\iurni\\sing-box-baidu'));
  assert(after('clients/desktop/build/installer.nsh').includes('Software\\iurni\\sing-box-baidu'));
  assert(!after('clients/desktop/build/installer.nsh').includes('$APPDATA\\sing-box"'));
  assert.equal(JSON.parse(after('clients/desktop/version.json')).version, '1.14.3-baidu.123');
  assert(!patches.has('experimental/boxdd/authenticode_windows.go'));
  assert(!patches.has('clients/desktop/scripts/afterPack.cjs'));
  // Planning reads source files without writing, including on patch failure.
  for (const [file, patch] of patches) assert.equal(readFileSync(join(root, file), 'utf8'), patch.before);
});

test('changed upstream patch anchor fails before any source write', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'baidu-windows-client-'));
  assert(fixture.startsWith(join(tmpdir(), 'baidu-windows-client-')));
  try {
    const files = [...planWindowsPatches(root, '1.14.3-baidu.123').keys()];
    for (const file of files) {
      mkdirSync(dirname(join(fixture, file)), { recursive: true });
      copyFileSync(join(root, file), join(fixture, file));
    }
    const anchorPath = join(fixture, 'clients/desktop/src/main/worker.ts');
    writeFileSync(anchorPath, readFileSync(anchorPath, 'utf8').replaceAll('sing-box-worker.', 'changed-worker.'));
    const before = files.map(file => readFileSync(join(fixture, file), 'utf8'));
    assert.throws(() => planWindowsPatches(fixture, '1.14.3-baidu.123'), /patch drift/);
    assert.deepEqual(files.map(file => readFileSync(join(fixture, file), 'utf8')), before);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

function fakeExecutable() {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88);
  bytes.write('Baidu mock executable content', 300);
  return bytes;
}

test('PE validation checks AMD64 and distinguishes code changes from Authenticode additions', () => {
  const unsigned = fakeExecutable();
  assert.equal(portableExecutableMachine(unsigned), 0x8664);
  const signed = Buffer.concat([unsigned, Buffer.alloc(128, 0x5a)]);
  signed.writeUInt32LE(123456, 88 + 64);
  signed.writeUInt32LE(512, 88 + 112 + 32);
  signed.writeUInt32LE(128, 88 + 112 + 36);
  assert.equal(executableContentDigest(unsigned), executableContentDigest(signed));
  signed[300] ^= 1;
  assert.notEqual(executableContentDigest(unsigned), executableContentDigest(signed));
  assert.throws(() => portableExecutableMachine(Buffer.alloc(128)), /PE executable/);
});

test('unsafe or non-monotonic client version inputs are refused', () => {
  for (const version of ['1.14.3', 'v1.14.3-baidu.1', '1.14.3-baidu.0', '1.14.3-baidu.1;cmd'])
    assert.throws(() => planWindowsPatches(root, version));
});

test('source scope accepts declared overlays and ignored build files but rejects unrelated tracked edits', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'baidu-windows-scope-'));
  assert(fixture.startsWith(join(tmpdir(), 'baidu-windows-scope-')));
  const client = join(fixture, 'clients/desktop');
  const dashboard = join(client, 'dashboard');
  const vendor = join(dashboard, 'vendor/iterm2-color-schemes');
  const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
  const commit = directory => git(directory, '-c', 'user.name=Baidu test', '-c', 'user.email=baidu-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  try {
    mkdirSync(client, { recursive: true });
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, 'colors.json'), '{}\n');
    git(vendor, 'init', '-q');
    git(vendor, 'add', '.');
    commit(vendor);
    mkdirSync(join(dashboard, 'src/components'), { recursive: true });
    writeFileSync(join(dashboard, 'src/components/iconPaths.ts'), 'original icons\n');
    writeFileSync(join(dashboard, 'other.ts'), 'original\n');
    git(dashboard, 'init', '-q');
    git(dashboard, 'add', '.');
    commit(dashboard);
    writeFileSync(join(client, '.gitignore'), '/bin/\n/signing.local.json\n');
    writeFileSync(join(client, 'version.json'), '{}\n');
    writeFileSync(join(client, 'other.ts'), 'original\n');
    git(client, 'init', '-q');
    git(client, 'add', '.');
    commit(client);
    writeFileSync(join(fixture, '.gitignore'), '/dist/\n');
    writeFileSync(join(fixture, 'main.go'), 'original\n');
    writeFileSync(join(fixture, 'other.go'), 'original\n');
    git(fixture, 'init', '-q');
    git(fixture, 'add', '.');
    commit(fixture);
    writeFileSync(join(fixture, 'main.go'), 'declared patch\n');
    writeFileSync(join(client, 'version.json'), '{"version":"custom"}\n');
    const state = { patches: [{ file: 'main.go' }, { file: 'clients/desktop/version.json' }],
      dashboardSource: git(dashboard, 'rev-parse', 'HEAD').trim(), generated: [] };
    mkdirSync(join(client, 'bin'), { recursive: true });
    writeFileSync(join(client, 'bin/daemon.exe'), 'ignored build\n');
    writeFileSync(join(client, 'signing.local.json'), '{}\n');
    assert.doesNotThrow(() => validateChangedSourceScope(fixture, state));
    assert.doesNotThrow(() => assertClientOverlayPaths(['version.json', 'dashboard'], ['version.json'], true));
    assert.throws(() => assertClientOverlayPaths(['version.json', 'dashboard'], ['version.json'], false), /SFW tracked working changes/);
    git(client, 'update-index', '--cacheinfo', '160000', git(client, 'rev-parse', 'HEAD').trim(), 'dashboard');
    assert.throws(() => validateChangedSourceScope(fixture, state), /index dashboard gitlink changed/);
    git(client, 'update-index', '--cacheinfo', '160000', state.dashboardSource, 'dashboard');
    // Reproduce the CI failure: only an untracked generation/cache output makes
    // the parent report "dashboard" dirty, without any dashboard source diff.
    writeFileSync(join(dashboard, '.pnpm-generated-state.json'), '{}\n');
    assert(git(client, 'diff', '--ignore-submodules=none', '--name-only', 'HEAD', '--').includes('dashboard'));
    assert.equal(git(dashboard, 'diff', '--ignore-submodules=none', '--name-only', 'HEAD', '--').trim(), '');
    assert.doesNotThrow(() => validateChangedSourceScope(fixture, state));
    const generatedPath = join(dashboard, 'src/components/iconPaths.ts');
    const generatedContent = 'generated icons\n';
    writeFileSync(generatedPath, generatedContent);
    state.generated = [{ file: 'clients/desktop/dashboard/src/components/iconPaths.ts',
      sha256: createHash('sha256').update(generatedContent).digest('hex'), changed: true,
      command: ['pnpm', '-C', 'clients/desktop/dashboard', 'generate'] }];
    assert.doesNotThrow(() => validateChangedSourceScope(fixture, state));
    writeFileSync(generatedPath, 'tampered icons\n');
    assert.throws(() => validateChangedSourceScope(fixture, state), /output changed after generation/);
    writeFileSync(generatedPath, generatedContent);
    writeFileSync(join(dashboard, 'other.ts'), 'unrelated tracked edit\n');
    assert.throws(() => validateChangedSourceScope(fixture, state), /Dashboard tracked changes/);
    writeFileSync(join(dashboard, 'other.ts'), 'original\n');
    writeFileSync(join(vendor, 'colors.json'), '{"tampered":true}\n');
    assert.throws(() => validateChangedSourceScope(fixture, state), /theme vendor must remain pristine/);
    writeFileSync(join(vendor, 'colors.json'), '{}\n');
    writeFileSync(join(vendor, 'untracked-color.json'), '{}\n');
    assert.throws(() => validateChangedSourceScope(fixture, state), /theme vendor must remain pristine/);
    rmSync(join(vendor, 'untracked-color.json'));
    writeFileSync(join(fixture, 'other.go'), 'unrelated tracked edit\n');
    assert.throws(() => validateChangedSourceScope(fixture, state), /Root tracked working changes/);
    writeFileSync(join(fixture, 'other.go'), 'original\n');
    writeFileSync(join(client, 'other.ts'), 'unrelated tracked edit\n');
    assert.throws(() => validateChangedSourceScope(fixture, state), /SFW tracked working changes/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the actual patched SFW version selector follows stable fork releases without repeat or downgrade prompts', () => {
  // Node distributions ship npm's SemVer implementation. Reuse that installed
  // dependency to exercise the exact selector without installing Electron first.
  let semver;
  for (const npmMetadata of [join(dirname(process.execPath), 'node_modules/npm/package.json'),
    join(dirname(process.execPath), '../lib/node_modules/npm/package.json')]) {
    try { semver = createRequire(npmMetadata)('semver'); break; } catch {}
  }
  assert(semver, 'The Node distribution must provide npm with SemVer.');
  const source = planWindowsPatches(root, '1.14.3-baidu.123').get('clients/desktop/src/main/updates.ts').after;
  const prereleaseLine = source.match(/^const APP_IS_PRERELEASE = .+;$/m)?.[0];
  const defaultTrack = source.match(/"update_track",\s*([^,\n]+),/)?.[1];
  const selector = source.match(/^function shouldIncludeVersion[\s\S]*?^}/m)?.[0]
    .replace('version: string, track: UpdateTrack): boolean', 'version, track)');
  assert(prereleaseLine && defaultTrack && selector);
  const evaluate = new Function('__APP_VERSION__', 'prerelease', 'valid', 'gt',
    `${prereleaseLine}\n${selector}\nreturn { defaultTrack: ${defaultTrack}, include: shouldIncludeVersion };`);
  const forVersion = current => evaluate(current, semver.prerelease, semver.valid, semver.gt);
  const installed = forVersion('1.14.3-baidu.100');
  assert.equal(installed.defaultTrack, 'stable');
  for (const [candidate, expected] of [
    ['1.14.3-baidu.100', false], ['1.14.3-baidu.99', false], ['1.14.3-baidu.101', true],
    ['1.14.4-baidu.1', true], ['1.14.4', true], ['1.14.2-baidu.999', false],
  ]) assert.equal(installed.include(candidate, 'stable'), expected, candidate);
  // Other upstream version formats retain their original prerelease semantics.
  const upstreamBeta = forVersion('1.14.4-beta.1');
  assert.equal(upstreamBeta.defaultTrack, 'beta');
  assert.equal(upstreamBeta.include('1.14.3', 'stable'), true);
  assert.equal(forVersion('1.14.3').defaultTrack, 'stable');
  assert.equal(forVersion('1.14.3').include('1.14.3', 'stable'), false);
  assert(source.includes('if (track === "stable" && release.prerelease)'));
});

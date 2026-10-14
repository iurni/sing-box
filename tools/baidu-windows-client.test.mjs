import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { executableContentDigest, planWindowsPatches, portableExecutableMachine, validateChangedSourceScope } from './baidu-windows-client.mjs';

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
  const git = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
  const commit = directory => git(directory, '-c', 'user.name=Baidu test', '-c', 'user.email=baidu-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  try {
    mkdirSync(client, { recursive: true });
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
    const state = { patches: [{ file: 'main.go' }, { file: 'clients/desktop/version.json' }] };
    mkdirSync(join(client, 'bin'), { recursive: true });
    writeFileSync(join(client, 'bin/daemon.exe'), 'ignored build\n');
    writeFileSync(join(client, 'signing.local.json'), '{}\n');
    assert.doesNotThrow(() => validateChangedSourceScope(fixture, state));
    writeFileSync(join(fixture, 'other.go'), 'unrelated tracked edit\n');
    assert.throws(() => validateChangedSourceScope(fixture, state), /Root tracked working changes/);
    writeFileSync(join(fixture, 'other.go'), 'original\n');
    writeFileSync(join(client, 'other.ts'), 'unrelated tracked edit\n');
    assert.throws(() => validateChangedSourceScope(fixture, state), /SFW tracked working changes/);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

#!/usr/bin/env node
// Build the pinned upstream SFW UI against this fork's source, never an official downloaded core.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLIENT = 'clients/desktop';
const DASHBOARD = `${CLIENT}/dashboard`;
const GENERATED_ICON_PATHS = `${DASHBOARD}/src/components/iconPaths.ts`;
const PRODUCT = 'sing-box Baidu';
const PACKAGE_DIRECTORY = 'dist/baidu-windows-packages';
const STATE = 'baidu-windows-state.json';
export const CHECKS = ['pinned-sfw-source', 'fork-update-source', 'isolated-installation',
  'source-built-baidu-daemon', 'amd64-pe', 'matching-authenticode-signatures', 'installer-product'];

function run(root, command, args, capture = false) {
  // .cmd package shims need a shell on Windows; no untrusted arguments reach this path.
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit', shell: process.platform === 'win32' && command === 'pnpm',
    maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || ''}`);
  return (result.stdout || '').trim();
}
function git(root, ...args) { return run(root, 'git', args, true); }
function hash(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function statePath(root) { return join(git(root, 'rev-parse', '--absolute-git-dir'), STATE); }
function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function output(name, value) {
  assert.match(value, /^[A-Za-z0-9.+-]+$/);
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, { flag: 'a' });
}

// Every patch has an exact expected match count. A changed stable client stops
// maintenance for review instead of silently emitting a stock or unsafe client.
export function planWindowsPatches(root, version) {
  assert.match(version, /^\d+\.\d+\.\d+-baidu\.[1-9][0-9]*$/);
  const files = new Map();
  function replace(file, original, replacement, count = 1) {
    const path = join(root, file);
    const before = files.has(file) ? files.get(file).after : readFileSync(path, 'utf8');
    const matches = before.split(original).length - 1;
    assert.equal(matches, count, `Windows client patch drift: ${file}: ${original}`);
    const after = before.split(original).join(replacement);
    files.set(file, { before: files.has(file) ? files.get(file).before : before, after });
  }
  const c = file => `${CLIENT}/${file}`;
  replace(c('electron-builder.yml'), 'productName: sing-box', `productName: ${PRODUCT}`);
  replace(c('electron-builder.yml'), 'appId: io.nekohasekai.sfw', 'appId: io.github.iurni.sfw.baidu');
  replace(c('electron-builder.yml'), 'name: sing-box profile', 'name: sing-box Baidu profile');
  replace(c('electron-builder.yml'), 'description: sing-box profile', 'description: sing-box Baidu profile');
  replace(c('build/installer.nsh'), 'Software\\SagerNet\\sing-box', 'Software\\iurni\\sing-box-baidu');
  replace(c('build/installer.nsh'), 'Software\\Classes\\*\\shell\\Taildrop', 'Software\\Classes\\*\\shell\\TaildropBaidu');
  replace(c('build/installer.nsh'), '$APPDATA\\sing-box-daemon', '$APPDATA\\sing-box-baidu-daemon', 3);
  replace(c('build/installer.nsh'), '$APPDATA\\sing-box"', '$APPDATA\\sing-box-baidu"', 4);
  replace(c('build/installer.nsh'), '$APPDATA\\sing-box-installer\\', '$APPDATA\\sing-box-baidu-installer\\');
  replace(c('build/installer.nsh'), '-Name sing-box-daemon', '-Name sing-box-baidu-daemon', 3);
  replace(c('build/installer-preflight.ps1'), '"sing-box-daemon"', '"sing-box-baidu-daemon"', 2);
  replace(c('src/main/installationLayout.ts'), 'SOFTWARE\\SagerNet\\sing-box', 'SOFTWARE\\iurni\\sing-box-baidu');
  replace(c('src/main/installationLayout.ts'), '"sing-box-daemon"', '"sing-box-baidu-daemon"');
  replace(c('src/main/applicationPaths.ts'), 'join(app.getPath("appData"), "sing-box")', 'join(app.getPath("appData"), "sing-box-baidu")');
  replace(c('src/main/applicationPaths.ts'), 'C:\\\\ProgramData\\\\sing-box-daemon', 'C:\\\\ProgramData\\\\sing-box-baidu-daemon', 2);
  replace(c('src/main/index.ts'), '"io.nekohasekai.sfw"', '"io.github.iurni.sfw.baidu"');
  // Do not take over the official client's protocol association on first start.
  replace(c('src/main/index.ts'), 'app.setAsDefaultProtocolClient("sing-box")', 'app.setAsDefaultProtocolClient("sing-box-baidu")');
  replace(c('src/main/index.ts'), 'sing-box:', 'sing-box-baidu:', 3);
  replace(c('src/main/updates.ts'), 'https://api.github.com/repos/SagerNet/sing-box/releases', 'https://api.github.com/repos/iurni/sing-box/releases');
  replace(c('src/main/updates.ts'), 'const APP_IS_PRERELEASE = prerelease(__APP_VERSION__) !== null;',
    'const APP_IS_PRERELEASE = !/^\\d+\\.\\d+\\.\\d+-baidu\\.\\d+$/.test(__APP_VERSION__) && prerelease(__APP_VERSION__) !== null;');
  replace(c('src/main/worker.ts'), 'sing-box-worker.', 'sing-box-baidu-worker.', 2);
  replace(c('src/main/worker.ts'), 'http://sing-box-worker', 'http://sing-box-baidu-worker');
  replace(c('src/main/daemon.ts'), 'Administrators\\\\sing-box"', 'Administrators\\\\sing-box-baidu"');
  replace('experimental/boxdd/main.go', 'const serviceName = "sing-box-daemon"', 'const serviceName = "sing-box-baidu-daemon"');
  replace('experimental/boxdd/cmd_service_windows.go', '"sing-box Service"', '"sing-box Baidu Service"');
  replace('experimental/boxdd/cmd_service_windows.go', '"Privileged service for sing-box"', '"Privileged service for sing-box Baidu"');
  replace('experimental/boxdd/cmd_service_windows.go', 'C:\\ProgramData\\sing-box-daemon', 'C:\\ProgramData\\sing-box-baidu-daemon');
  replace('experimental/boxdd/server_windows.go', 'Administrators\\sing-box`', 'Administrators\\sing-box-baidu`');
  replace('experimental/boxdd/peer_windows.go', 'applicationExecutableName = "sing-box.exe"', `applicationExecutableName = "${PRODUCT}.exe"`);
  replace('experimental/boxdd/peer_windows.go', 'sing-box-worker.', 'sing-box-baidu-worker.');
  replace('experimental/boxdd/update_windows.go', 'updateProductName      = "sing-box"', `updateProductName      = "${PRODUCT}"`);
  const metadataPath = c('version.json');
  const metadataBefore = readFileSync(join(root, metadataPath), 'utf8');
  const metadata = JSON.parse(metadataBefore);
  assert.match(metadata.go_version, /^go[1-9][0-9]*\.[0-9]+\.[0-9]+$/);
  files.set(metadataPath, { before: metadataBefore, after: JSON.stringify({ ...metadata, version }, null, 2) + '\n' });
  return files;
}

function prepare(root, version) {
  assert(!existsSync(statePath(root)), 'Windows preparation already ran; use a fresh checkout.');
  const head = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  const gitlink = git(root, 'ls-tree', 'HEAD', CLIENT).split(/\s+/)[2];
  const appSource = git(join(root, CLIENT), 'rev-parse', 'HEAD');
  assert.match(gitlink, /^[a-f0-9]{40}$/);
  assert.equal(appSource, gitlink, 'SFW source must use the upstream stable gitlink.');
  assert.equal(git(join(root, CLIENT), 'status', '--porcelain'), '', 'SFW preparation requires pristine client sources.');
  const dashboardSource = git(join(root, CLIENT), 'ls-tree', 'HEAD', 'dashboard').split(/\s+/)[2];
  assert.equal(git(join(root, DASHBOARD), 'rev-parse', 'HEAD'), dashboardSource,
    'The dashboard source must use the stable desktop gitlink.');
  assert(readFileSync(join(root, 'include/registry.go'), 'utf8').includes('baidu.RegisterOutbound'));
  const patches = planWindowsPatches(root, version);
  const packageMetadata = json(join(root, CLIENT, 'package.json'));
  assert.match(packageMetadata.engines.node, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  assert.match(packageMetadata.packageManager, /^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/);
  const clientMetadata = json(join(root, CLIENT, 'version.json'));
  const upstreamTag = readFileSync(join(root, '.github/baidu-upstream-version'), 'utf8').trim();
  assert.equal(version.split('-')[0], upstreamTag.slice(1));
  // Local annotated tag lets the upstream daemon builder emit exactly the GUI
  // version. It is never pushed and does not change HEAD or the source tree ID.
  const localTag = `v${version}`;
  if (git(root, 'tag', '--list', localTag)) assert.equal(git(root, 'rev-list', '-n', '1', localTag), head);
  else run(root, 'git', ['-c', 'user.name=Baidu CI', '-c', 'user.email=baidu-ci@users.noreply.github.com',
    'tag', '-a', localTag, '-m', 'Local client build version', head]);
  assert.equal(git(root, 'describe', '--tags'), localTag, 'Client and core version tag mismatch.');
  for (const [file, change] of patches) writeFileSync(join(root, file), change.after);
  const state = { schema: 1, head, tree, upstreamTag, appSource, dashboardSource, version, product: PRODUCT,
    generated: [],
    patches: [...patches].map(([file, change]) => ({ file, before: hash(change.before), after: hash(change.after) })) };
  writeFileSync(statePath(root), JSON.stringify(state, null, 2) + '\n');
  output('go_version', clientMetadata.go_version.slice(2));
  output('node_version', packageMetadata.engines.node);
  output('pnpm_version', packageMetadata.packageManager.slice(5));
  output('rust_version', '1.88.0');
  console.log(`Prepared pinned SFW ${appSource.slice(0, 12)} for ${version}; certificate secrets are required.`);
}

export function validateChangedSourceScope(root, state) {
  const rootPaths = state.patches.map(patch => patch.file).filter(file => !file.startsWith(`${CLIENT}/`));
  const clientPaths = state.patches.map(patch => patch.file)
    .filter(file => file.startsWith(`${CLIENT}/`)).map(file => file.slice(CLIENT.length + 1));
  // A submodule with only untracked build/cache output is reported dirty by
  // --ignore-submodules=none even when its own tracked diff is empty. This gate
  // binds tracked source changes; check the read-only theme vendor separately.
  const changed = directory => git(directory, 'diff', '--ignore-submodules=untracked', '--name-only', 'HEAD', '--')
    .split(/\r?\n/).filter(Boolean).sort();
  if (state.dashboardSource) {
    const clientDirectory = join(root, CLIENT);
    const headDashboardSource = git(clientDirectory, 'ls-tree', 'HEAD', 'dashboard').split(/\s+/)[2];
    assert.equal(headDashboardSource, state.dashboardSource, 'The SFW HEAD dashboard gitlink changed.');
    const stagedDashboard = git(clientDirectory, 'ls-files', '--stage', '--', 'dashboard').split(/\s+/);
    assert.deepEqual(stagedDashboard, ['160000', state.dashboardSource, '0', 'dashboard'],
      'The SFW index dashboard gitlink changed or is conflicted.');
    assert.equal(git(join(root, DASHBOARD), 'rev-parse', 'HEAD'), state.dashboardSource,
      'The pinned dashboard source changed during packaging.');
    const vendorPath = 'vendor/iterm2-color-schemes';
    const vendorSource = git(join(root, DASHBOARD), 'ls-tree', 'HEAD', vendorPath).split(/\s+/)[2];
    assert.equal(git(join(root, DASHBOARD, vendorPath), 'rev-parse', 'HEAD'), vendorSource,
      'The pinned dashboard theme vendor changed during packaging.');
    assert.equal(git(join(root, DASHBOARD, vendorPath), 'status', '--porcelain', '--untracked-files=all'), '',
      'The dashboard theme vendor must remain pristine during packaging.');
    const generated = state.generated || [];
    for (const output of generated) {
      assert.equal(output.file, GENERATED_ICON_PATHS, 'Unexpected declared dashboard generator output.');
      assert.equal(hash(readFileSync(join(root, output.file))), output.sha256,
        'A declared dashboard generator output changed after generation.');
    }
    const expectedDashboard = generated.filter(output => output.changed)
      .map(output => output.file.slice(DASHBOARD.length + 1)).sort();
    assert.deepEqual(changed(join(root, DASHBOARD)), expectedDashboard,
      'Dashboard tracked changes do not exactly match its declared generated icon file.');
  }
  assert.deepEqual(changed(root), [...rootPaths, CLIENT].sort(),
    'Root tracked working changes do not exactly match the declared Windows overlay.');
  assertClientOverlayPaths(changed(join(root, CLIENT)), clientPaths, Boolean(state.dashboardSource));
}

export function assertClientOverlayPaths(actual, expected, dashboardChecked) {
  // The parent gitlink's dirty marker is not evidence of a source-content diff:
  // HEAD/index pointers and the nested sources were independently checked above.
  const scoped = dashboardChecked ? actual.filter(file => file !== 'dashboard') : actual;
  assert.deepEqual(scoped.sort(), [...expected].sort(),
    'SFW tracked working changes do not exactly match the declared Windows overlay.');
}

function validateState(root) {
  const state = json(statePath(root));
  assert.equal(state.schema, 1);
  assert.equal(git(root, 'rev-parse', 'HEAD'), state.head);
  assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), state.tree);
  assert.equal(git(join(root, CLIENT), 'rev-parse', 'HEAD'), state.appSource);
  for (const patch of state.patches) assert.equal(hash(readFileSync(join(root, patch.file))), patch.after, `Modified client patch: ${patch.file}`);
  validateChangedSourceScope(root, state);
  return state;
}

function build(root) {
  assert.equal(process.platform, 'win32', 'SFW installer must be built on a Windows runner.');
  const state = validateState(root);
  assert(existsSync(join(root, CLIENT, 'signing.local.json')), 'Run the Windows signing helper with persistent certificate secrets first.');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  run(root, 'pnpm', ['-C', CLIENT, 'install', '--frozen-lockfile']);
  // Upstream generation rewrites iconPaths.ts, which is a tracked generated
  // dashboard file. Generate it before packaging and bind that exact output
  // digest; the package command reruns the generator and must reproduce it.
  run(root, 'pnpm', ['-C', DASHBOARD, 'install', '--frozen-lockfile']);
  run(root, 'pnpm', ['-C', DASHBOARD, 'generate']);
  const dashboardChanges = git(join(root, DASHBOARD), 'diff', '--ignore-submodules=untracked', '--name-only', 'HEAD', '--')
    .split(/\r?\n/).filter(Boolean);
  assert(dashboardChanges.every(file => file === 'src/components/iconPaths.ts'),
    `Unexpected dashboard generator changes: ${dashboardChanges.join(', ')}`);
  state.generated = [{ file: GENERATED_ICON_PATHS, sha256: hash(readFileSync(join(root, GENERATED_ICON_PATHS))),
    command: ['pnpm', '-C', DASHBOARD, 'generate'], changed: dashboardChanges.length !== 0 }];
  writeFileSync(statePath(root), JSON.stringify(state, null, 2) + '\n');
  validateState(root);
  run(root, 'pnpm', ['-C', CLIENT, 'package:win', '--', 'x64']);
  // Upstream's package command builds cmd/internal/build_boxdd from repository
  // root; its afterPack signs both daemon and Rust module, retaining peer checks.
}

export function portableExecutableMachine(bytes) {
  assert(bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a, 'Not a PE executable.');
  const offset = bytes.readUInt32LE(0x3c);
  assert(offset >= 64 && offset + 6 <= bytes.length && bytes.subarray(offset, offset + 4).equals(Buffer.from('PE\0\0')));
  return bytes.readUInt16LE(offset + 4);
}

export function executableContentDigest(bytes) {
  portableExecutableMachine(bytes);
  const header = bytes.readUInt32LE(0x3c);
  const optional = header + 24;
  const magic = bytes.readUInt16LE(optional);
  assert(magic === 0x20b || magic === 0x10b, 'Unsupported PE optional header.');
  const securityDirectory = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  assert(securityDirectory + 8 <= bytes.length);
  const certificateOffset = bytes.readUInt32LE(securityDirectory);
  const certificateSize = bytes.readUInt32LE(securityDirectory + 4);
  assert((certificateOffset === 0 && certificateSize === 0) ||
    (certificateOffset > securityDirectory + 8 && certificateOffset + certificateSize === bytes.length),
  'Unexpected Authenticode overlay.');
  const payload = Buffer.from(bytes.subarray(0, certificateOffset || bytes.length));
  // SignTool changes only these header fields and appends an aligned certificate.
  payload.fill(0, optional + 64, optional + 68);
  payload.fill(0, securityDirectory, securityDirectory + 8);
  const padding = Buffer.alloc((8 - payload.length % 8) % 8);
  return hash(Buffer.concat([payload, padding]));
}

function verify(root) {
  assert.equal(process.platform, 'win32');
  const state = validateState(root);
  const unpacked = join(root, CLIENT, 'release/win-unpacked');
  const app = join(unpacked, `${PRODUCT}.exe`);
  const daemon = join(unpacked, 'resources/daemon/sing-box-daemon.exe');
  const sharingModule = join(unpacked, 'resources/native/windows_share.node');
  const filenames = readdirSync(join(root, CLIENT, 'release')).filter(name => /^SFW-.*-x64\.exe$/.test(name));
  assert.deepEqual(filenames, [`SFW-${state.version}-x64.exe`]);
  const installer = join(root, CLIENT, 'release', filenames[0]);
  assert.equal(run(root, daemon, ['version'], true).split(/\r?\n/)[0], `sing-box-daemon version ${state.version}`,
    'Packaged daemon cannot run or its core version differs from the GUI.');
  for (const executable of [app, daemon, sharingModule]) assert.equal(portableExecutableMachine(readFileSync(executable)), 0x8664);
  assert(readFileSync(daemon).includes(Buffer.from('github.com/sagernet/sing-box/protocol/baidu.NewOutbound')), 'Packaged daemon is missing the Baidu outbound.');
  assert.equal(executableContentDigest(readFileSync(daemon)),
    executableContentDigest(readFileSync(join(root, CLIENT, 'bin/windows/x64/sing-box-daemon.exe'))),
    'Packaged daemon content differs from the daemon built from this fork.');
  // Paths only; credentials stay in runner secret environment and ignored files.
  const signatureMetadataPath = join(dirname(statePath(root)), 'baidu-windows-signatures.json');
  run(root, 'pwsh', ['-NoProfile', '-File', 'tools/baidu-windows-signing.ps1', '-Verify',
    '-ApplicationPath', app, '-DaemonPath', daemon, '-ModulePath', sharingModule,
    '-InstallerPath', installer, '-MetadataPath', signatureMetadataPath]);
  const signatures = json(signatureMetadataPath);
  assert.equal(signatures.product, PRODUCT);
  assert.match(signatures.signerSHA256, /^[a-f0-9]{64}$/);
  verifyWithDaemonTrustPolicy(root, { app, daemon, sharingModule, installer });
  const artifact = { filename: filenames[0], sha256: hash(readFileSync(installer)) };
  const destination = join(root, PACKAGE_DIRECTORY);
  mkdirSync(destination, { recursive: true });
  copyFileSync(installer, join(destination, artifact.filename));
  const receipt = { schema: 1, success: true, head: state.head, tree: state.tree,
    upstreamTag: state.upstreamTag, appSource: state.appSource, dashboardSource: state.dashboardSource,
    generated: state.generated, version: state.version,
    target: 'windows/amd64-gui', checks: CHECKS, signerSHA256: signatures.signerSHA256,
    coreContainsBaidu: true, applicationMachine: 'amd64', daemonSHA256: hash(readFileSync(daemon)),
    patches: state.patches, artifacts: [artifact] };
  writeFileSync(join(destination, 'WINDOWS-VALIDATION.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Verified ${artifact.filename}: AMD64 GUI, custom Baidu daemon, matching self-signed identity.`);
}

function verifyWithDaemonTrustPolicy(root, paths) {
  const fixture = join(root, 'experimental/boxdd/baidu_packaging_ci_test.go');
  assert(!existsSync(fixture), 'Temporary package verification fixture already exists.');
  const environmentNames = ['BAIDU_CI_APPLICATION', 'BAIDU_CI_DAEMON', 'BAIDU_CI_MODULE', 'BAIDU_CI_INSTALLER', 'GOTOOLCHAIN'];
  const previous = new Map(environmentNames.map(name => [name, process.env[name]]));
  // These test entry points run the actual unmodified upstream certificate
  // verifier and layout/update validation. No service is installed or started.
  const source = `//go:build windows
package main
import (
  "crypto/sha256"
  "fmt"
  "os"
  "strings"
  "testing"
  "golang.org/x/sys/windows"
)
func TestBaiduPackagedSignatures(t *testing.T) {
  for _, name := range []string{"BAIDU_CI_APPLICATION", "BAIDU_CI_DAEMON", "BAIDU_CI_MODULE", "BAIDU_CI_INSTALLER"} {
    path := os.Getenv(name)
    handle, err := openLockedExecutable(path)
    if err != nil { t.Fatal(err) }
    signer, err := authenticodeSigner(path, handle)
    windows.CloseHandle(handle)
    if err != nil { t.Fatalf("%s: %v", name, err) }
    if fmt.Sprintf("%x", sha256.Sum256(signer)) != strings.ToLower(os.Getenv("BAIDU_WINDOWS_CERT_SHA256")) {
      t.Fatalf("%s signer differs from the persistent fork identity", name)
    }
  }
  _, application, err := installedApplicationPath(os.Getenv("BAIDU_CI_DAEMON"))
  if err != nil || !strings.EqualFold(application, os.Getenv("BAIDU_CI_APPLICATION")) {
    t.Fatalf("packaged GUI / daemon layout does not match: %s, %v", application, err)
  }
  identity, err := windowsExecutableIdentity(os.Getenv("BAIDU_CI_INSTALLER"))
  if err != nil { t.Fatal(err) }
  if identity.productName != updateProductName { t.Fatal("installer product identity does not match the daemon updater") }
  if err := validateNSISExecutable(os.Getenv("BAIDU_CI_INSTALLER")); err != nil { t.Fatal(err) }
}
`;
  try {
    writeFileSync(fixture, source, { flag: 'wx' });
    process.env.BAIDU_CI_APPLICATION = paths.app;
    process.env.BAIDU_CI_DAEMON = paths.daemon;
    process.env.BAIDU_CI_MODULE = paths.sharingModule;
    process.env.BAIDU_CI_INSTALLER = paths.installer;
    process.env.GOTOOLCHAIN = json(join(root, CLIENT, 'version.json')).go_version;
    const tags = `${readFileSync(join(root, 'release/DEFAULT_BUILD_TAGS_WINDOWS'), 'utf8').trim()},with_external_windivert,with_external_usbip_drivers`;
    const flags = readFileSync(join(root, 'release/LDFLAGS'), 'utf8').trim();
    run(root, 'go', ['test', '-count=1', '-timeout=5m', '-run', '^TestBaiduPackagedSignatures$', '-tags', tags,
      '-ldflags', flags, './experimental/boxdd']);
  } finally {
    rmSync(fixture, { force: true });
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.cwd();
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'prepare') {
      assert.deepEqual(args.slice(0, 1), ['--version']);
      assert.equal(args.length, 2);
      prepare(root, args[1]);
    } else {
      assert.equal(args.length, 0);
      if (mode === 'build') build(root);
      else if (mode === 'verify') verify(root);
      else throw new Error('Usage: baidu-windows-client.mjs prepare --version <version> | build | verify');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

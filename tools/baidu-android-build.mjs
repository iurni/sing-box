#!/usr/bin/env node
// Build the official pinned Android UI with this checkout's custom libbox.
// Signing material lives only in Actions secrets / an ignored build directory.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const APP_ID = 'io.github.iurni.singbox.baidu';
export const APP_NAME = 'SFA Baidu';
export const CLIENT_URL = 'https://github.com/SagerNet/sing-box-for-android.git';
export const PACKAGE_DIRECTORY = 'dist/baidu-android-packages';

function run(command, args, { cwd = process.cwd(), env = {}, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}). ${capture ? result.stderr || '' : ''}`);
  return (result.stdout || '').trim();
}
function git(...args) { return run('git', args, { capture: true }); }
function sha256(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function isDescendant(parent, path) {
  const child = relative(parent, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function assertGeneratedPath(root, path) {
  const absolute = resolve(path);
  const workRoot = resolve(root, 'dist/baidu-android-work');
  if (!isDescendant(workRoot, absolute)) throw new Error('Refusing to clean outside the generated Android work directory.');
  let existingAncestor = absolute;
  while (!existsSync(existingAncestor)) existingAncestor = dirname(existingAncestor);
  const physicalRoot = realpathSync(root);
  const physicalAncestor = realpathSync(existingAncestor);
  if (physicalAncestor !== physicalRoot && !isDescendant(physicalRoot, physicalAncestor))
    throw new Error('Generated Android build path resolves outside the core workspace.');
  return absolute;
}
function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Required build setting ${name} is missing.`);
  return process.env[name];
}
function replaceOnce(text, from, to, label) {
  if (text.split(from).length !== 2) throw new Error(`Upstream Android ${label} changed; update the build overlay before releasing.`);
  return text.replace(from, to);
}

export function readAndroidRequirements(clientRoot) {
  const build = readFileSync(join(clientRoot, 'app/build.gradle.kts'), 'utf8');
  const compileSdk = build.match(/\bcompileSdk\s*=\s*(\d+)\b/)?.[1];
  const minor = build.match(/\bcompileSdkMinor\s*=\s*(\d+)\b/)?.[1];
  const ndk = build.match(/\bndkVersion\s*=\s*"(\d+(?:\.\d+){2})"/)?.[1];
  if (!compileSdk || !ndk) throw new Error('Cannot determine the pinned Android SDK/NDK requirements.');
  return {
    java: 17,
    // gomobile v0.1.13 only recognizes integer platform directory suffixes;
    // android-37.1 alone cannot supply its API-24 Java binding bootclasspath.
    sdkPackages: ['platforms;android-24', `platforms;android-${compileSdk}${minor ? `.${minor}` : ''}`, `build-tools;${compileSdk}.0.0`, `ndk;${ndk}`],
    buildTools: `${compileSdk}.0.0`, ndk,
  };
}

export function overlayGradle(text) {
  text = replaceOnce(text, 'applicationId = "io.nekohasekai.sfa"', `applicationId = "${APP_ID}"`, 'application identifier');
  text = replaceOnce(text, 'base.archivesName.set("SFA-${versionName}")', 'base.archivesName.set("SFA-Baidu-${versionName}")', 'archive name');
  text = replaceOnce(text, 'include("armeabi-v7a", "arm64-v8a", "x86", "x86_64")', 'include("arm64-v8a")', 'ABI splits');
  text = replaceOnce(text, 'isUniversalApk = true', 'isUniversalApk = false', 'universal APK');
  // AGP rejects defaultConfig.ndk.abiFilters together with ABI splits. The
  // single ABI split filters native dependencies too; verify the final APK below.
  // Keep the upstream namespace so generated and handwritten classes match.
  return text;
}

export function androidUpdateChecker() {
  return `package io.nekohasekai.sfa.vendor

import io.nekohasekai.libbox.Libbox
import io.nekohasekai.sfa.BuildConfig
import io.nekohasekai.sfa.ktx.unwrap
import io.nekohasekai.sfa.update.UpdateInfo
import io.nekohasekai.sfa.update.UpdateTrack
import io.nekohasekai.sfa.utils.HTTPClient
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.Closeable

// The fork has its own signature and application ID. Never install upstream APKs.
class GitHubUpdateChecker : Closeable {
    companion object {
        private const val RELEASES_URL = "https://api.github.com/repos/iurni/sing-box/releases"
        private const val METADATA_FILENAME = "SFA-version-metadata.json"
    }

    private val client = Libbox.newHTTPClient().apply {
        modernTLS()
        keepAlive()
    }
    private val json = Json { ignoreUnknownKeys = true }

    @Suppress("UNUSED_PARAMETER")
    fun checkUpdate(track: UpdateTrack, githubToken: String): UpdateInfo? {
        val request = client.newRequest()
        request.setURL("$RELEASES_URL/latest")
        request.setHeader("Accept", "application/vnd.github+json")
        val token = githubToken.trim()
        if (token.isNotEmpty()) request.setHeader("Authorization", "Bearer $token")
        request.setUserAgent(HTTPClient.userAgent)
        val release = json.decodeFromString<GitHubRelease>(request.execute().content.unwrap)
        if (release.draft || release.prerelease) return null
        val metadataAsset = release.assets.find { it.name == METADATA_FILENAME } ?: return null
        val metadataRequest = client.newRequest()
        metadataRequest.setURL(metadataAsset.browserDownloadUrl)
        metadataRequest.setUserAgent(HTTPClient.userAgent)
        val metadata = json.decodeFromString<VersionMetadata>(metadataRequest.execute().content.unwrap)
        if (metadata.applicationId != BuildConfig.APPLICATION_ID || metadata.versionCode <= BuildConfig.VERSION_CODE) return null
        val asset = release.assets.find {
            it.name.startsWith("SFA-Baidu-") && it.name.endsWith("-arm64-v8a.apk")
        } ?: return null
        return UpdateInfo(
            versionCode = metadata.versionCode,
            versionName = metadata.versionName,
            downloadUrl = asset.browserDownloadUrl,
            releaseUrl = release.htmlUrl,
            releaseNotes = release.body,
            isPrerelease = false,
            fileSize = asset.size,
        )
    }

    override fun close() { client.close() }

    @Serializable
    data class GitHubRelease(
        val body: String? = null,
        val draft: Boolean = false,
        val prerelease: Boolean = false,
        @SerialName("html_url") val htmlUrl: String = "",
        val assets: List<GitHubAsset> = emptyList(),
    )
    @Serializable
    data class GitHubAsset(
        val name: String = "",
        @SerialName("browser_download_url") val browserDownloadUrl: String = "",
        val size: Long = 0,
    )
    @Serializable
    data class VersionMetadata(
        @SerialName("version_code") val versionCode: Int = 0,
        @SerialName("version_name") val versionName: String = "",
        @SerialName("application_id") val applicationId: String = "",
    )
}
`;
}

export function validateBadging(badging, version, versionCode) {
  if (!badging.includes(`name='${APP_ID}'`) || !badging.includes(`versionCode='${versionCode}'`) || !badging.includes(`versionName='${version}'`))
    throw new Error('APK package/version metadata does not match this fork build.');
  if (!/^application-label(?:-[^:]+)?:'SFA Baidu'$/m.test(badging)) throw new Error('APK application name was not overlaid.');
  if (!/^sdkVersion:'24'$/m.test(badging)) throw new Error('The modern APK must have minimum SDK 24 (Android 7).');
  if (!/^native-code: 'arm64-v8a'$/m.test(badging)) throw new Error('APK is not exclusively arm64-v8a.');
}

export function validateNativeCore(native, version) {
  if (native.length < 64 || !native.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      native[4] !== 2 || native[5] !== 1 || native.readUInt16LE(18) !== 183)
    throw new Error('APK libbox is not an ELF64 AArch64 library.');
  if (!native.includes(Buffer.from('github.com/sagernet/sing-box/protocol/baidu')) || !native.includes(Buffer.from(version)))
    throw new Error('The APK does not contain this custom Baidu core / expected core version.');
}

function pinnedClient(root) {
  const gitlink = git('ls-tree', 'HEAD', 'clients/android').match(/^160000 commit ([0-9a-f]{40})\tclients\/android$/)?.[1];
  if (!gitlink) throw new Error('The official clients/android pinned submodule is missing.');
  const directory = assertGeneratedPath(root, join(root, 'dist/baidu-android-work/client'));
  if (!existsSync(join(directory, '.git'))) {
    mkdirSync(directory, { recursive: true });
    run('git', ['init', directory], { capture: true });
    run('git', ['-C', directory, 'remote', 'add', 'origin', CLIENT_URL], { capture: true });
  }
  if (run('git', ['-C', directory, 'remote', 'get-url', 'origin'], { capture: true }) !== CLIENT_URL)
    throw new Error('Android build checkout has an unexpected remote.');
  const markerPath = join(root, 'dist/baidu-android-work/BUILD-OWNER.json');
  const marker = { schema: 1, purpose: 'baidu-android-build', root: resolve(root) };
  if (existsSync(markerPath) && JSON.stringify(JSON.parse(readFileSync(markerPath, 'utf8'))) !== JSON.stringify(marker))
    throw new Error('Generated Android build directory belongs to a different checkout.');
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
  run('git', ['-C', directory, 'fetch', '--depth=1', 'origin', gitlink]);
  run('git', ['-C', directory, 'checkout', '--force', '--detach', gitlink]);
  // This is the isolated generated checkout only, never clients/android or user files.
  assertGeneratedPath(root, directory);
  run('git', ['-C', directory, 'clean', '-ffd']);
  return { directory, commit: gitlink };
}

function overlayClient(client, version, versionCode) {
  const gradlePath = join(client.directory, 'app/build.gradle.kts');
  writeFileSync(gradlePath, overlayGradle(readFileSync(gradlePath, 'utf8')));
  const resources = join(client.directory, 'app/src/main/res');
  for (const entry of readdirSync(resources)) {
    const strings = join(resources, entry, 'strings.xml');
    if (!existsSync(strings)) continue;
    const text = readFileSync(strings, 'utf8');
    writeFileSync(strings, text.replace(/(<string\s+name="app_name"[^>]*>)[^<]*(<\/string>)/g, `$1${APP_NAME}$2`));
  }
  // Keep broadcast actions separate while preserving the upstream class namespace.
  const actions = [
    'app/src/main/java/io/nekohasekai/sfa/constant/Action.kt',
    'app/src/main/java/io/nekohasekai/sfa/bg/USBIPService.kt',
    'app/src/main/java/io/nekohasekai/sfa/bg/TaildropSendService.kt',
    'app/src/main/java/io/nekohasekai/sfa/compose/screen/usbip/UsbAttach.kt',
    'app/src/github/java/io/nekohasekai/sfa/vendor/InstallResultReceiver.kt',
    'app/src/github/AndroidManifest.xml', 'app/src/other/AndroidManifest.xml',
  ];
  for (const filename of actions) {
    const path = join(client.directory, filename);
    if (!existsSync(path)) throw new Error(`Pinned client action location changed: ${filename}`);
    writeFileSync(path, readFileSync(path, 'utf8').replace(/"io\.nekohasekai\.sfa\.(?=SERVICE|action\.|INSTALL_COMPLETE)/g, `"${APP_ID}.`));
  }
  writeFileSync(join(client.directory, 'app/src/github/java/io/nekohasekai/sfa/vendor/GitHubUpdateChecker.kt'), androidUpdateChecker());
  const propsPath = join(client.directory, 'version.properties');
  let props = readFileSync(propsPath, 'utf8');
  if (!/^VERSION_NAME=.+$/m.test(props) || !/^VERSION_CODE=\d+$/m.test(props)) throw new Error('Client version.properties format changed.');
  props = props.replace(/^VERSION_NAME=.+$/m, `VERSION_NAME=${version}`).replace(/^VERSION_CODE=\d+$/m, `VERSION_CODE=${versionCode}`);
  writeFileSync(propsPath, props);
}

function javaProperty(value) {
  return value.replace(/\\/g, '\\\\').replace(/[\n\r\t\f]/g, char => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\f': '\\f' }[char]))
    .replace(/([ :=#!])/g, '\\$1').replace(/[^\x20-\x7e]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

async function main() {
  const root = process.cwd();
  const mode = process.argv[2] || 'build';
  if (!['build', 'requirements'].includes(mode) || process.argv.length > 3) throw new Error('Use baidu-android-build.mjs [build|requirements].');
  const client = pinnedClient(root);
  const requirements = readAndroidRequirements(client.directory);
  if (mode === 'requirements') {
    console.log(JSON.stringify({ ...requirements, clientCommit: client.commit }));
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `sdk_packages=${requirements.sdkPackages.join(' ')}\nndk=${requirements.ndk}\n`, { flag: 'a' });
    return;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('APK builds run on the GitHub Actions Linux amd64 runner.');
  if (git('status', '--porcelain')) throw new Error('APK construction requires a clean committed core checkout.');
  const upstreamTag = readFileSync('.github/baidu-upstream-version', 'utf8').trim();
  if (!/^v\d+\.\d+\.\d+$/.test(upstreamTag)) throw new Error('Only a stable upstream release can build this APK.');
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const version = requiredEnv('BAIDU_APP_VERSION');
  if (!new RegExp(`^${upstreamTag.slice(1).replaceAll('.', '\\.')}\\-baidu\\.[0-9]+$`).test(version)) throw new Error('App version must match the stable fork release and Actions run ID.');
  const versionCode = Number(requiredEnv('BAIDU_ANDROID_VERSION_CODE'));
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2147483647) throw new Error('Android versionCode must be a positive signed 32-bit integer.');
  const expectedCertificate = requiredEnv('BAIDU_ANDROID_CERT_SHA256').replaceAll(':', '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedCertificate)) throw new Error('Invalid expected Android signing certificate SHA-256.');
  const signing = {
    KEYSTORE_PASS: requiredEnv('BAIDU_ANDROID_STORE_PASSWORD'),
    ALIAS_NAME: requiredEnv('BAIDU_ANDROID_KEY_ALIAS'),
    ALIAS_PASS: requiredEnv('BAIDU_ANDROID_KEY_PASSWORD'),
  };
  const keystoreBase64 = requiredEnv('BAIDU_ANDROID_KEYSTORE_BASE64');
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(keystoreBase64)) throw new Error('Android signing keystore must be base64 encoded.');
  const signingPath = join(client.directory, 'app/release.keystore');
  writeFileSync(signingPath, Buffer.from(keystoreBase64, 'base64'), { mode: 0o600 });
  const secretEnv = { LOCAL_PROPERTIES: Buffer.from(Object.entries(signing).map(([key, value]) => `${key}=${javaProperty(value)}\n`).join('')).toString('base64') };
  const output = resolve(PACKAGE_DIRECTORY);
  mkdirSync(output, { recursive: true });
  rmSync(join(output, 'ANDROID-VALIDATION.json'), { force: true });
  try {
    overlayClient(client, version, versionCode);
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error('Android SDK path is missing.');
    const tools = join(sdk, 'build-tools', requirements.buildTools);
    const ndk = join(sdk, 'ndk', requirements.ndk);
    if (!existsSync(join(ndk, 'source.properties')) || !existsSync(join(tools, 'apksigner'))) throw new Error('Pinned Android SDK build-tools / NDK are not installed.');
    const java = run('java', ['--version'], { capture: true });
    if (!/openjdk 17\b/.test(java)) throw new Error('The Android library requires OpenJDK 17.');
    run('make', ['lib_install']);
    const gopath = run('go', ['env', 'GOPATH'], { capture: true });
    const gomobile = join(gopath, 'bin/gomobile');
    const builderSource = readFileSync('cmd/internal/build_libbox/main.go', 'utf8');
    const tags = [...builderSource.matchAll(/sharedTags = append\(sharedTags,([\s\S]*?)\)/g)].flatMap(match => [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map(tag => tag[1]));
    for (const required of ['with_quic', 'with_gvisor', 'with_clash_api', 'with_utls', 'with_naive_outbound'])
      if (!tags.includes(required)) throw new Error(`Official Android library build tags changed (${required} missing).`);
    const library = join(client.directory, 'app/libs/libbox.aar');
    mkdirSync(join(client.directory, 'app/libs'), { recursive: true });
    const ldflags = `-X github.com/sagernet/sing-box/constant.Version=${version} ${readFileSync('release/LDFLAGS', 'utf8').trim()} -s -w -buildid=`;
    run(gomobile, ['bind', '-v', '-o', library, '-target', 'android/arm64', '-androidapi', '24', '-javapkg=io.nekohasekai', '-libname=box', '-trimpath', '-buildvcs=false', '-ldflags', ldflags, '-tags', tags.join(','), './experimental/libbox'], {
      env: { ANDROID_HOME: sdk, ANDROID_NDK_HOME: ndk, NDK: ndk, PATH: `${gopath}/bin:${process.env.PATH}`, GOTOOLCHAIN: 'local' },
    });
    // Output directories are generated in this isolated checkout. Drop stale
    // APK outputs so a retry cannot package an artifact from an earlier run.
    rmSync(assertGeneratedPath(root, join(client.directory, 'app/build/outputs/apk/other/release')), { recursive: true, force: true });
    run('bash', ['gradlew', '--no-daemon', ':app:assembleOtherRelease'], { cwd: client.directory, env: { ...secretEnv, ANDROID_HOME: sdk, ANDROID_NDK_HOME: ndk } });
    const apks = readdirSync(join(client.directory, 'app/build/outputs/apk/other/release')).filter(name => name.endsWith('.apk'));
    if (apks.length !== 1 || !apks[0].endsWith('-arm64-v8a.apk')) throw new Error('Expected one modern arm64-v8a APK.');
    const builtApk = join(client.directory, 'app/build/outputs/apk/other/release', apks[0]);
    validateBadging(run(join(tools, 'aapt2'), ['dump', 'badging', builtApk], { capture: true }), version, versionCode);
    const signature = run(join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', builtApk], { capture: true });
    const certificate = signature.match(/Signer #1 certificate SHA-256 digest: ([0-9a-fA-F]{64})/)?.[1]?.toLowerCase();
    if (certificate !== expectedCertificate || /Signer #2 certificate/.test(signature)) throw new Error('APK signer does not match the persistent fork signing certificate.');
    const archiveEntries = run('unzip', ['-Z1', builtApk], { capture: true }).split('\n');
    if (!archiveEntries.includes('lib/arm64-v8a/libbox.so') || archiveEntries.some(name => /^lib\/(?!arm64-v8a\/)/.test(name))) throw new Error('APK native ABI set is incorrect.');
    const nativePath = join(client.directory, 'libbox-from-apk.so');
    const extracted = spawnSync('unzip', ['-p', builtApk, 'lib/arm64-v8a/libbox.so'], { maxBuffer: 256 * 1024 * 1024 });
    if (extracted.status !== 0 || extracted.error) throw extracted.error || new Error('Cannot inspect APK libbox.');
    writeFileSync(nativePath, extracted.stdout);
    const native = readFileSync(nativePath);
    validateNativeCore(native, version);
    const filename = `SFA-Baidu-${version}-arm64-v8a.apk`;
    copyFileSync(builtApk, join(output, filename));
    writeFileSync(join(output, 'SFA-version-metadata.json'), `${JSON.stringify({ version_code: versionCode, version_name: version, application_id: APP_ID }, null, 2)}\n`);
    if (git('rev-parse', 'HEAD') !== head || git('rev-parse', 'HEAD^{tree}') !== tree || git('status', '--porcelain')) throw new Error('Core checkout changed during APK construction.');
    const artifacts = [filename, 'SFA-version-metadata.json'].map(filename => ({ filename, sha256: sha256(join(output, filename)) }));
    const receipt = { schema: 1, success: true, head, tree, upstreamTag, version, versionCode, applicationId: APP_ID,
      appSource: client.commit, appSourceRepository: CLIENT_URL, target: 'android/arm64-v8a', minSdk: 24,
      certificateSha256: certificate, signerSHA256: certificate, coreContainsBaidu: true,
      librarySha256: sha256(library), apkLibboxSha256: sha256(nativePath),
      buildTags: tags, checks: ['official-pinned-client', 'custom-libbox-built-from-core', 'apk-assembly', 'apk-signature', 'package-id', 'version-metadata', 'arm64-v8a-only', 'elf64-aarch64-libbox', 'baidu-core-provenance'], artifacts };
    writeFileSync(join(output, 'ANDROID-VALIDATION.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Built and verified ${filename} (${APP_ID}, Android 7+, arm64-v8a).`);
  } finally {
    rmSync(signingPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });

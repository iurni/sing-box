import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { overlayGradle, readAndroidRequirements, validateBadging, validateNativeCore, validateSignature, androidUpdateChecker, APP_ID } from './baidu-android-build.mjs';

test('SDK requirements provide an integer platform for gomobile alongside the GUI compile SDK', () => {
  const client = mkdtempSync(join(tmpdir(), 'baidu-android-sdk-fixture-'));
  try {
    mkdirSync(join(client, 'app'));
    writeFileSync(join(client, 'app/build.gradle.kts'), 'compileSdk = 37\ncompileSdkMinor = 1\nndkVersion = "28.0.13004108"\n');
    assert.deepEqual(readAndroidRequirements(client).sdkPackages, ['platforms;android-24', 'platforms;android-37.1', 'build-tools;37.0.0', 'ndk;28.0.13004108']);
  } finally {
    // The test deletes only the exact absolute directory returned by mkdtemp.
    assert.equal(dirname(resolve(client)), resolve(tmpdir()));
    assert.ok(basename(client).startsWith('baidu-android-sdk-fixture-'));
    rmSync(client, { recursive: true, force: true });
  }
});

test('Android overlay uses a separate app ID and removes all non-arm64 outputs', () => {
  const upstream = 'applicationId = "io.nekohasekai.sfa"\nbase.archivesName.set("SFA-${versionName}")\ninclude("armeabi-v7a", "arm64-v8a", "x86", "x86_64")\nisUniversalApk = true\ntargetSdk = 37';
  const patched = overlayGradle(upstream);
  assert.match(patched, /applicationId = "io.github.iurni.singbox.baidu"/);
  assert.match(patched, /include\("arm64-v8a"\)/);
  assert.doesNotMatch(patched, /abiFilters/);
  assert.match(patched, /isUniversalApk = false/);
  assert.doesNotMatch(patched, /armeabi-v7a|x86/);
  assert.throws(() => overlayGradle(upstream.replace('isUniversalApk = true', 'isUniversalApk = false')), /changed/);
});

test('APK metadata gate rejects another package, ABI, version or minimum SDK', () => {
  const correct = `package: name='${APP_ID}' versionCode='1791958400' versionName='1.14.3-baidu.1234'\napplication-label:'SFA Baidu'\nsdkVersion:'24'\nnative-code: 'arm64-v8a'`;
  assert.doesNotThrow(() => validateBadging(correct, '1.14.3-baidu.1234', 1791958400));
  for (const field of ['sdkVersion', 'minSdkVersion']) {
    for (const value of ['24', '24.0'])
      assert.doesNotThrow(() => validateBadging(correct.replace("sdkVersion:'24'", `${field}:'${value}'`), '1.14.3-baidu.1234', 1791958400));
    for (const value of ['23', '25', '24.1'])
      assert.throws(() => validateBadging(correct.replace("sdkVersion:'24'", `${field}:'${value}'`), '1.14.3-baidu.1234', 1791958400), /minimum SDK 24.*Actual APK metadata/);
  }
  for (const [from, to] of [[APP_ID, 'io.nekohasekai.sfa'], ["sdkVersion:'24'", "sdkVersion:'21'"], ["native-code: 'arm64-v8a'", "native-code: 'arm64-v8a' 'x86'"], ['1791958400', '1791958401']])
    assert.throws(() => validateBadging(correct.replace(from, to), '1.14.3-baidu.1234', 1791958400));
});

test('Android updater stays on fork stable APKs and compares metadata version codes', () => {
  const updater = androidUpdateChecker();
  assert.match(updater, /repos\/iurni\/sing-box\/releases/);
  assert.match(updater, /release\.draft \|\| release\.prerelease/);
  assert.match(updater, /metadata\.applicationId != BuildConfig\.APPLICATION_ID/);
  assert.match(updater, /metadata\.versionCode <= BuildConfig\.VERSION_CODE/);
  assert.match(updater, /endsWith\("-arm64-v8a\.apk"\)/);
  assert.doesNotMatch(updater, /SagerNet\/sing-box|compareSemver/);
});

test('Native core gate refuses a wrong ELF architecture or stock library', () => {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(183, 18);
  const native = Buffer.concat([header, Buffer.from('github.com/sagernet/sing-box/protocol/baidu\0v1.14.3-baidu.1234')]);
  assert.doesNotThrow(() => validateNativeCore(native, '1.14.3-baidu.1234'));
  const otherArchitecture = Buffer.from(native);
  otherArchitecture.writeUInt16LE(62, 18);
  assert.throws(() => validateNativeCore(otherArchitecture, '1.14.3-baidu.1234'), /AArch64/);
  assert.throws(() => validateNativeCore(header, '1.14.3-baidu.1234'), /custom Baidu/);
  assert.throws(() => validateNativeCore(native, '1.14.3-baidu.9999'), /expected core version/);
});

test('APK signature gate recognizes v3.1 SDK ranges without accepting a different signer', () => {
  const certificate = '12'.repeat(32);
  const oldOutput = `Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${certificate}`;
  const newOutput = `Number of signers: 1\nSigner (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${certificate}\nSigner (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${certificate}`;
  assert.equal(validateSignature(oldOutput, certificate), certificate);
  assert.equal(validateSignature(newOutput, certificate), certificate);
  assert.throws(() => validateSignature(newOutput.replace(certificate, '34'.repeat(32)), certificate), /actual signature metadata/);
  assert.throws(() => validateSignature(oldOutput.replace('Number of signers: 1', 'Number of signers: 2'), certificate));
  assert.throws(() => validateSignature(`${oldOutput}\nSigner #2 certificate SHA-256 digest: ${certificate}`, certificate));
  assert.throws(() => validateSignature(`Number of signers: 1\nSource Stamp Signer certificate SHA-256 digest: ${certificate}`, certificate));
});

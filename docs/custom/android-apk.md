# Android application

The Android release is an installable **SFA Baidu** APK for **arm64-v8a**, with
Android 7.0 (API 24) or later required. It uses the official Android client commit
pinned by the core repository's `clients/android` submodule. Its `libbox.aar` is
built from the same custom core commit as the release, including `type: "baidu"`.

The application ID is `io.github.iurni.singbox.baidu`. It can coexist with the
official `io.nekohasekai.sfa` application and has separate profiles and settings.
Its updater checks stable releases of `iurni/sing-box`, chooses the arm64-v8a APK,
and compares the version code in `SFA-version-metadata.json`. It never downloads
an official SagerNet APK as an update to the custom application.

Import a complete sing-box JSON profile, or paste it into the local profile
editor. Import and editor validation use the bundled custom `Libbox.checkConfig`;
the modern editor obtains its schema from that same core, so the `baidu` outbound
is recognized without an additional node form or client schema patch.

An active official SFA Xposed module can reject the fork's separate application
ID during the optional hook status query. On the affected Xiaomi 15, the startup
log showed `SecurityException: unauthorized` from `HookStatusClient.refresh`,
before the VPN was started. The client overlay treats a `SecurityException` or
`RemoteException` from hook status and package-list IPC as an unavailable hook:
it clears the hook status and returns the existing nullable fallback result.
Normal profile and VPN operation can continue without that optional module.
Module error-log IPC returns its existing `REMOTE_ERROR` result for these same
two exceptions. The overlay preserves parcel cleanup and the module's caller
authorization based on the caller UID's package names; other exceptions are not
suppressed. The custom application does not gain access to the official module's
privileged features through this fallback.

The release signing key is persistent. Actions reads the keystore from
`BAIDU_ANDROID_KEYSTORE_BASE64`, with `BAIDU_ANDROID_STORE_PASSWORD`,
`BAIDU_ANDROID_KEY_ALIAS`, and `BAIDU_ANDROID_KEY_PASSWORD` as repository secrets.
The public certificate fingerprint is the `BAIDU_ANDROID_CERT_SHA256` repository
variable. Keep the signing key backed up outside this repository: replacing it
prevents installed copies from accepting future updates. No private key or
provider credential is stored in the source tree or release artifacts.

The GitHub Ubuntu build uses Java 17, the SDK / NDK versions declared by the
pinned client, its exact stable `GO_VERSION` from `version.properties`, and the
official `make lib_install` gomobile version. The core module's minimum Go version
does not select the Android compiler. Missing or invalid client Go requirements
and an installed compiler version mismatch stop the build. Only the
modern Android library and `:app:assembleOtherRelease` arm64-v8a application are
built. SDK platform 24 is also installed for gomobile's Java binding classpath:
gomobile 0.1.13 recognizes integer platform names, while the client uses a minor
compile SDK such as `android-37.1`. The client's compile SDK stays unchanged.
The APK gate checks its signature against the expected certificate,
package ID, label, version, minimum SDK, native ABIs, and the custom Baidu code
and core version in `libbox.so`. `ANDROID-VALIDATION.json` records the source
commits, Go compiler version, and artifact digests. These checks confirm package
construction; device VPN operation and a provider's real endpoint still require
device/network tests.

The workflow passes `BAIDU_APP_VERSION` as `<stable-version>-baidu.<run-id>` and
`BAIDU_ANDROID_VERSION_CODE` as its captured UTC epoch seconds. The latter must
stay within Android's positive signed 32-bit version-code range; the build stops
if it exceeds the bound. Both the manifest and update metadata use the same
values.

## Startup crash diagnostics

If SFA Baidu closes when opened, connect the phone with USB debugging authorized,
open the app once to reproduce the crash, and run the read-only collector from
this checkout:

```powershell
.\tools\collect-android-crash.ps1
```

Use `-Serial <adb-device-id>` when more than one phone is connected. The collector
saves Android/model/page-size information, this package's process exit history,
and its crash/logcat entries under the ignored `dist/android-crash-*` directory.
It does not install or remove apps, start a VPN, clear log buffers, change phone
settings, or read profile configurations. Native tombstones are filtered by
package name because their emitting debugger process has a different PID.

A Go compiler mismatch is a build defect, but compiler alignment and static APK
checks alone do not confirm the cause of a particular device's startup crash.

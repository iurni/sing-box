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

The release signing key is persistent. Actions reads the keystore from
`BAIDU_ANDROID_KEYSTORE_BASE64`, with `BAIDU_ANDROID_STORE_PASSWORD`,
`BAIDU_ANDROID_KEY_ALIAS`, and `BAIDU_ANDROID_KEY_PASSWORD` as repository secrets.
The public certificate fingerprint is the `BAIDU_ANDROID_CERT_SHA256` repository
variable. Keep the signing key backed up outside this repository: replacing it
prevents installed copies from accepting future updates. No private key or
provider credential is stored in the source tree or release artifacts.

The GitHub Ubuntu build uses Java 17, the SDK / NDK versions declared by the
pinned client, and the official `make lib_install` gomobile version. Only the
modern Android library and `:app:assembleOtherRelease` arm64-v8a application are
built. The APK gate checks its signature against the expected certificate,
package ID, label, version, minimum SDK, native ABIs, and the custom Baidu code
and core version in `libbox.so`. `ANDROID-VALIDATION.json` records the source
commits and artifact digests. These checks confirm package construction; device
VPN operation and a provider's real endpoint still require device/network tests.

The workflow passes `BAIDU_APP_VERSION` as `<stable-version>-baidu.<run-id>` and
`BAIDU_ANDROID_VERSION_CODE` as its captured UTC epoch seconds. The latter must
stay within Android's positive signed 32-bit version-code range; the build stops
if it exceeds the bound. Both the manifest and update metadata use the same
values.

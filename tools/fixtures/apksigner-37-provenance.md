# Signature parser fixture

`apksigner-37-official.txt` is the actual stdout of Google's SDK Build-Tools
37.0.0 `apksigner.jar` verifying the public official
`SFA-1.14.3-arm64-v8a.apk` release, with `verify --verbose --print-certs`.
The APK was verified, not executed. No signing key was used or inspected.

The SDK archive is Google's
`https://dl.google.com/android/repository/build-tools_r37_linux.zip`.
Its published SHA-1 was checked before extracting only `lib/apksigner.jar`:
`70954e99f4c3d9d46ee70fa32624672fe7cd6ebe`.
The extracted jar SHA-256 is
`2defad215d7ff52968a409cde528cdaef7918b115e276b8e3378ca7a178e4180`.

The official APK is available from
`https://github.com/SagerNet/sing-box/releases/tag/v1.14.3`.
An independent parse of the same tool's `--print-certs-pem` output with Node's
`X509Certificate` agrees with the fixture's certificate SHA-256:
`32250a4b5f3a6733df57a3b9ec16c38d2c7fc5f2f693a9636f8f7b3be3549641`.
That certificate belongs to the official app. The custom app always checks its
separate persistent fork certificate; this fixture is only a parser regression.

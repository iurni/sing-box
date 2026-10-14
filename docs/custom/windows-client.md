# Windows AMD64 graphical client

The EXE asset named `SFW-<version>-x64.exe` is the upstream Electron SFW installer,
built from the `clients/desktop` commit pinned by the current stable sing-box
release. Its `sing-box-daemon.exe` is compiled from this repository, including the
custom `baidu` outbound. This differs from the command-line `sing-box.exe` ZIP.

The fork uses the product name **sing-box Baidu**, application ID
`io.github.iurni.sfw.baidu`, a separate installation registry key, separate
profile/service data directories, service name `sing-box-baidu-daemon`, and
separate local pipes. Its update checker reads `iurni/sing-box` Releases. It does
not replace the official client's installation or update channel.

## Signing

The Windows daemon authenticates its GUI and worker using matching Authenticode
signatures. Unsigned builds do not work with this security model. We preserve
the upstream checks and sign the GUI, daemon, native module, and installer using
the same persistent fork certificate. The upstream verifier accepts a currently
valid self-signed code signing certificate; importing it into Windows Trusted
Root stores is unnecessary. This is **not an official SagerNet signature** and
Windows may show an unknown publisher / SmartScreen warning.

The repository requires these GitHub settings:

- Secret `BAIDU_WINDOWS_PFX_BASE64`: base64 of the private signing PFX.
- Secret `BAIDU_WINDOWS_PFX_PASSWORD`: its password.
- Variable `BAIDU_WINDOWS_CERT_SHA256`: SHA-256 of the DER public certificate.

Keep the certificate for subsequent releases. Changing the signing certificate
prevents the existing daemon from accepting an in-app update; certificate
rotation requires a deliberate reinstall/migration. Never commit a PFX,
password, or `clients/desktop/signing.local.json` to Git.

## Build and verification

Use a Windows runner with Visual Studio C++ build tools / Windows SDK (as provided
by GitHub `windows-latest`) and Rust 1.88.0 with the
`x86_64-pc-windows-msvc` target. Initialize the pinned desktop and dashboard
submodules first. `prepare` reads the required Go, Node, and pnpm versions from
the client metadata, exports them through `GITHUB_OUTPUT`, and applies checked
fork identity patches only in the build checkout. For the initial 1.14.3 client
these are Go 1.26.8, Node 26.7.0, and pnpm 11.13.0.

```powershell
git submodule update --init --recursive clients/desktop
node tools/baidu-windows-client.mjs prepare --version 1.14.3-baidu.123
# Set up Go/Node/pnpm versions emitted by prepare and Rust/MSVC above.
# Inject signing secrets and the public fingerprint as environment variables.
pwsh -NoProfile -File tools/baidu-windows-signing.ps1
node tools/baidu-windows-client.mjs build
node tools/baidu-windows-client.mjs verify
```

Preparation refuses mismatched client commits or changed upstream patch anchors.
Build and verification also refuse tracked root/client changes outside the
declared identity/version overlay. The pinned dashboard generator rewrites the
tracked `src/components/iconPaths.ts`; the build records that command and output
digest before packaging, then requires packaging to reproduce it. Other dashboard
changes, vendor changes, and a changed icon digest fail validation. Ignored
generated output, untracked dashboard build/cache output, and local signing
settings remain permitted. The read-only theme vendor is checked separately and
must retain its pinned commit and pristine tracked/untracked contents.
The official package command builds the daemon locally, includes the upstream
drivers and Cronet library, builds the Rust sharing module, and runs its signing
and Electron integrity hooks. Verification checks PE AMD64 architecture, the
Baidu constructor in the packaged daemon, identical daemon content before and
after signing, the pinned signature on every component, and the installer product.
It also executes the packaged daemon's version command and runs the unmodified
daemon certificate verifier against the signed GUI, daemon, native module, and
installer. That check validates the GUI/daemon installation layout and NSIS
installer identity without registering a service or starting a VPN.

`dist/baidu-windows-packages` contains the installer and
`WINDOWS-VALIDATION.json`, with the root commit/tree, pinned client commit,
checked patch digests, certificate fingerprint, and installer SHA-256. The receipt
also records the pinned dashboard commit and generated icon digest. Neither the
certificate key nor any subscription credentials are included.

The local protocol mock tests do not prove that a real provider accepts your
gateway/account. A client package may build successfully while a particular
Baidu gateway remains inaccessible on your network.

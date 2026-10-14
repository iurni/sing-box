[CmdletBinding()]
param(
    [switch]$Verify,
    [string]$ApplicationPath,
    [string]$DaemonPath,
    [string]$ModulePath,
    [string]$InstallerPath,
    [string]$MetadataPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$expectedFingerprint = $env:BAIDU_WINDOWS_CERT_SHA256
if ($expectedFingerprint -notmatch '^[a-fA-F0-9]{64}$') {
    throw 'BAIDU_WINDOWS_CERT_SHA256 must pin the persistent code signing certificate.'
}
$expectedFingerprint = $expectedFingerprint.ToLowerInvariant()

function Get-CertificateSha256([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($Certificate.RawData)).ToLowerInvariant()
}

function Assert-CodeSigningCertificate([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
    if ($null -eq $Certificate -or (Get-CertificateSha256 $Certificate) -ne $expectedFingerprint) {
        throw 'The code signing certificate does not match the pinned SHA-256 fingerprint.'
    }
    $now = Get-Date
    if ($now -lt $Certificate.NotBefore -or $now -gt $Certificate.NotAfter) {
        throw 'The code signing certificate is not currently valid.'
    }
    $codeSigningUsage = $false
    foreach ($extension in $Certificate.Extensions) {
        if ($extension -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
            foreach ($usage in $extension.EnhancedKeyUsages) {
                if ($usage.Value -eq '1.3.6.1.5.5.7.3.3') { $codeSigningUsage = $true }
            }
        }
    }
    if (-not $codeSigningUsage) { throw 'The certificate is not intended for code signing.' }
}

if ($Verify) {
    foreach ($path in @($ApplicationPath, $DaemonPath, $ModulePath, $InstallerPath)) {
        if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw 'A signed Windows package component is missing.'
        }
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        Assert-CodeSigningCertificate $signature.SignerCertificate
        # A self-signed leaf is deliberately not installed into a trust root.
        # WinTrust reports NotTrusted / UnknownError for that chain, while the
        # upstream daemon explicitly accepts an intact, valid self-signed leaf.
        if ($signature.Status -notin @('Valid', 'NotTrusted', 'UnknownError')) {
            throw "A package component has an invalid Authenticode signature: $($signature.Status)"
        }
        if ($signature.SignerCertificate.Subject -ne $signature.SignerCertificate.Issuer -and $signature.Status -ne 'Valid') {
            throw 'An untrusted signer must be self-signed, matching the daemon trust policy.'
        }
    }
    $product = (Get-Item -LiteralPath $InstallerPath).VersionInfo.ProductName
    if ($product -ne 'sing-box Baidu') { throw 'The EXE installer has an unexpected product identity.' }
    $metadata = @{ product = $product; signerSHA256 = $expectedFingerprint; signing = 'fork-self-signed' }
    [IO.File]::WriteAllText($MetadataPath, ($metadata | ConvertTo-Json) + "`n", [Text.UTF8Encoding]::new($false))
    Write-Output 'Verified the installer, GUI, daemon, and native module signing identity.'
    exit 0
}

if ([string]::IsNullOrWhiteSpace($env:BAIDU_WINDOWS_PFX_BASE64) -or
    [string]::IsNullOrWhiteSpace($env:BAIDU_WINDOWS_PFX_PASSWORD)) {
    throw 'Persistent BAIDU_WINDOWS_PFX_BASE64 and BAIDU_WINDOWS_PFX_PASSWORD secrets are required; unsigned builds are not supported.'
}
$temporaryRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { [IO.Path]::GetTempPath() } else { $env:RUNNER_TEMP }
$certificatePath = Join-Path $temporaryRoot ('baidu-signing-' + [Guid]::NewGuid().ToString('N') + '.pfx')
$certificate = $null
$encodedCertificate = $null
try {
    try { $encodedCertificate = [Convert]::FromBase64String($env:BAIDU_WINDOWS_PFX_BASE64) }
    catch { throw 'BAIDU_WINDOWS_PFX_BASE64 is not a valid encoded certificate.' }
    [IO.File]::WriteAllBytes($certificatePath, $encodedCertificate)
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $certificatePath, $env:BAIDU_WINDOWS_PFX_PASSWORD,
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    )
    Assert-CodeSigningCertificate $certificate
    if (-not $certificate.HasPrivateKey) { throw 'The signing PFX contains no private key.' }
    $settings = @{ windows = @{ certificateFile = $certificatePath; certificatePassword = $env:BAIDU_WINDOWS_PFX_PASSWORD } }
    [IO.File]::WriteAllText(
        (Join-Path (Get-Location) 'clients/desktop/signing.local.json'),
        ($settings | ConvertTo-Json -Depth 3) + "`n", [Text.UTF8Encoding]::new($false)
    )
    # Both certificate path and password remain runner-local; no key material is
    # written to an artifact or printed in logs. Runner teardown removes the PFX.
    Write-Output 'Configured the fork signing certificate. No trust root was installed.'
} catch {
    if (Test-Path -LiteralPath $certificatePath) { Remove-Item -LiteralPath $certificatePath -Force }
    throw
} finally {
    if ($null -ne $certificate) { $certificate.Dispose() }
    if ($null -ne $encodedCertificate) { [Array]::Clear($encodedCertificate, 0, $encodedCertificate.Length) }
}

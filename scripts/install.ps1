# Installs Kinfold on Windows. It downloads the program for this machine,
# checks it against the release's SHA256SUMS, then runs the program's own
# `install`, which writes <dataDir>\bin\kinfold.exe and wires the hosts.
#
# KINFOLD_VERSION picks a release. Without it the latest release is used.
# KINFOLD_RELEASE_BASE replaces the release folder, and is honoured only for a
# loopback or file URL, so an environment variable cannot send an install to
# another host and a test never reaches GitHub.

$ErrorActionPreference = 'Stop'

function Fail([string] $message) {
  [Console]::Error.WriteLine("kinfold: $message")
  exit 1
}

function Unsupported([string] $hostName) {
  Fail "no build for $hostName. Supported: macOS (arm64, x64), Linux glibc (x64, arm64), Windows x64."
}

function ReleaseBase {
  if (-not [string]::IsNullOrEmpty($env:KINFOLD_RELEASE_BASE)) {
    $candidate = $env:KINFOLD_RELEASE_BASE.TrimEnd('/')
    if ($candidate.StartsWith('http://127.0.0.1') -or $candidate.StartsWith('file://')) {
      return $candidate
    }
    Fail 'KINFOLD_RELEASE_BASE must start with http://127.0.0.1 or file://'
  }
  if (-not [string]::IsNullOrEmpty($env:KINFOLD_VERSION)) {
    if ($env:KINFOLD_VERSION -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') {
      Fail 'KINFOLD_VERSION must be a version, using letters, digits, dots, plus and hyphen'
    }
    return "https://github.com/yahyafakhroji/kinfold/releases/download/v$($env:KINFOLD_VERSION)"
  }
  return 'https://github.com/yahyafakhroji/kinfold/releases/latest/download'
}

function Download([string] $url, [string] $destination) {
  if ($url.StartsWith('file://')) {
    Copy-Item -LiteralPath ([uri] $url).LocalPath -Destination $destination -Force
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destination
  }
}

$machine = $env:PROCESSOR_ARCHITEW6432
if ([string]::IsNullOrEmpty($machine)) {
  $machine = $env:PROCESSOR_ARCHITECTURE
}
switch ($machine) {
  'AMD64' { $arch = 'x64' }
  'ARM64' { $arch = 'arm64' }
  'x86' { $arch = 'ia32' }
  default {
    if ([string]::IsNullOrEmpty($machine)) {
      $arch = 'unknown'
    } else {
      $arch = $machine.ToLowerInvariant()
    }
  }
}
if ($arch -ne 'x64') {
  Unsupported "win32-$arch"
}
$asset = 'kinfold-windows-x64.exe'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("kinfold-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $base = ReleaseBase
  $sums = Join-Path $tmp 'SHA256SUMS'
  $program = Join-Path $tmp $asset
  Download "$base/SHA256SUMS" $sums
  Download "$base/$asset" $program

  $expected = $null
  foreach ($line in Get-Content -LiteralPath $sums) {
    if ($line -cmatch '^([0-9a-f]{64})  ([^\s/\\]+)$' -and $Matches[2] -eq $asset) {
      $expected = $Matches[1]
      break
    }
  }
  if ([string]::IsNullOrEmpty($expected)) {
    Fail "SHA256SUMS has no entry for $asset; nothing was installed"
  }

  $actual = (Get-FileHash -LiteralPath $program -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Fail "the downloaded $asset does not match SHA256SUMS; nothing was installed"
  }

  & $program install @args
  $code = $LASTEXITCODE
  if ($null -eq $code) {
    $code = 1
  }
  exit $code
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

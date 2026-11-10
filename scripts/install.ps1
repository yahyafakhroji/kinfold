# Installs Kinfold on Windows. It downloads the program for this machine,
# checks it against the release's SHA256SUMS, then runs the program's own
# `install`, which writes <dataDir>\bin\kinfold.exe and wires the hosts.
#
# KINFOLD_VERSION picks a release. Without it the latest release is used.
# KINFOLD_RELEASE_BASE replaces the release folder, and is honoured only for an
# exact loopback origin or a file URL, so an environment variable cannot send an
# install to another host and a test never reaches GitHub.
#
# The script runs both from a file and as `irm <url> | iex`. Under iex it runs
# inside the user's own session, where `exit` would close their PowerShell, so
# every failure is thrown to one handler at the end. That handler exits with the
# code when run from a file, and otherwise sets $LASTEXITCODE and returns. The
# body is a script block so its functions and settings stay out of that session.

& {
  $ErrorActionPreference = 'Stop'
  # The program's own exit code is the result, so a nonzero one must not turn into an error.
  $PSNativeCommandUseErrorActionPreference = $false
  $exitCodeKey = 'KinfoldExitCode'

  function Fail([string] $message, [int] $code = 1) {
    $failure = [System.Exception]::new($message)
    $failure.Data[$exitCodeKey] = $code
    throw $failure
  }

  function Unsupported([string] $hostName) {
    Fail "no build for $hostName. Supported: macOS (arm64, x64), Linux glibc (x64, arm64), Windows x64."
  }

  # A prefix test would also admit http://127.0.0.1.evil.com, http://127.0.0.10 and
  # the userinfo form http://127.0.0.1@evil.com, so the whole origin is checked:
  # host exactly 127.0.0.1, an optional numeric port, then the end or a path. A
  # file URL needs a path after file:///, since a bare one trims to file:.
  function Test-LocalBase([string] $candidate) {
    if ($candidate -cmatch '^http://127\.0\.0\.1(?::[0-9]+)?(?:/[^\r\n]*)?\z') {
      return $true
    }
    return $candidate -cmatch '^file:///[^/\r\n][^\r\n]*\z'
  }

  function ReleaseBase {
    if (-not [string]::IsNullOrEmpty($env:KINFOLD_RELEASE_BASE)) {
      if (-not (Test-LocalBase $env:KINFOLD_RELEASE_BASE)) {
        Fail 'KINFOLD_RELEASE_BASE must be http://127.0.0.1 with an optional port and path, or a file:// URL with an absolute path'
      }
      return $env:KINFOLD_RELEASE_BASE.TrimEnd('/')
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

  function MachineArch {
    $machine = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrEmpty($machine)) {
      $machine = $env:PROCESSOR_ARCHITECTURE
    }
    switch ($machine) {
      'AMD64' { return 'x64' }
      'ARM64' { return 'arm64' }
      'x86' { return 'ia32' }
    }
    if ([string]::IsNullOrEmpty($machine)) {
      return 'unknown'
    }
    return $machine.ToLowerInvariant()
  }

  # The SHA-256 the release lists for $asset; the program never runs unless it matches.
  function ExpectedHash([string] $sums, [string] $asset) {
    foreach ($line in Get-Content -LiteralPath $sums) {
      if ($line -cmatch '^([0-9a-f]{64})  ([^\s/\\]+)$' -and $Matches[2] -eq $asset) {
        return $Matches[1]
      }
    }
    Fail "SHA256SUMS has no entry for $asset; nothing was installed"
  }

  $code = 1
  try {
    $arch = MachineArch
    if ($arch -ne 'x64') {
      Unsupported "win32-$arch"
    }
    $asset = 'kinfold-windows-x64.exe'
    # Validate before touching the filesystem, so a refused base leaves no trace.
    $base = ReleaseBase

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("kinfold-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null
    try {
      $sums = Join-Path $tmp 'SHA256SUMS'
      $program = Join-Path $tmp $asset
      Download "$base/SHA256SUMS" $sums
      Download "$base/$asset" $program

      $expected = ExpectedHash $sums $asset
      $actual = (Get-FileHash -LiteralPath $program -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actual -ne $expected) {
        Fail "the downloaded $asset does not match SHA256SUMS; nothing was installed"
      }

      $env:KINFOLD_INSTALL_CHANNEL = 'powershell'
      & $program install @args
      $code = $LASTEXITCODE
      if ($null -eq $code) {
        $code = 1
      }
    } finally {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {
    $failure = $_.Exception
    $code = 1
    if ($failure.Data.Contains($exitCodeKey)) {
      $code = [int] $failure.Data[$exitCodeKey]
    }
    [Console]::Error.WriteLine("kinfold: $($failure.Message)")
  }

  if (-not [string]::IsNullOrEmpty($PSCommandPath)) {
    exit $code
  }
  $global:LASTEXITCODE = $code
} @args

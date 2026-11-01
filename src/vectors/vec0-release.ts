// The one sqlite-vec build SAM loads: v0.1.9's loadable macOS asset, pinned
// by hash. `sam install` downloads the tarball and checks `tarballSha256`
// (GitHub's published digest); the daemon checks `dylibSha256` before every
// load, because loading a dylib runs its code. A new version means new
// hashes here, read from the release, not from the downloaded bytes.

export interface Vec0Asset {
  url: string
  tarballSha256: string
  /** The single member the tarball holds. */
  member: 'vec0.dylib'
  dylibSha256: string
}

export const VEC0_VERSION = '0.1.9'

export const VEC0_ASSETS: Readonly<Partial<Record<string, Vec0Asset>>> = {
  arm64: {
    url: `https://github.com/asg017/sqlite-vec/releases/download/v${VEC0_VERSION}/sqlite-vec-${VEC0_VERSION}-loadable-macos-aarch64.tar.gz`,
    tarballSha256: '8282126333399ddfe98bbbcc7a1936e7252625aac49df056a98be602e46bfd29',
    member: 'vec0.dylib',
    dylibSha256: '193e480c50b59a55977d166f4aaf0e1bc8832d6963516e5950f39e4d2ce0b793',
  },
}

/** Null where no pinned build exists (Intel Macs: add their hashes once checked; other platforms). */
export function vec0AssetFor(platform: string, arch: string): Vec0Asset | null {
  return platform === 'darwin' ? VEC0_ASSETS[arch] ?? null : null
}

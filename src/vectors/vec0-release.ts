// The sqlite-vec builds Kinfold loads, one per target, pinned by hash.
// `kinfold install` downloads the tarball and checks `tarballSha256`
// (GitHub's published digest); the daemon checks `fileSha256` on the unpacked
// member before every load, because loading one runs its code. A new version
// means new hashes here, read from the release, not from downloaded bytes.

export type Vec0Member = 'vec0.dylib' | 'vec0.so' | 'vec0.dll'

export interface Vec0Asset {
  url: string
  tarballSha256: string
  /** The single member the tarball holds. */
  member: Vec0Member
  fileSha256: string
}

export const VEC0_VERSION = '0.1.9'

export const VEC0_ASSETS: Readonly<Record<string, Vec0Asset>> = {
  'darwin-arm64': {
    url: `https://github.com/asg017/sqlite-vec/releases/download/v${VEC0_VERSION}/sqlite-vec-${VEC0_VERSION}-loadable-macos-aarch64.tar.gz`,
    tarballSha256: '8282126333399ddfe98bbbcc7a1936e7252625aac49df056a98be602e46bfd29',
    member: 'vec0.dylib',
    fileSha256: '193e480c50b59a55977d166f4aaf0e1bc8832d6963516e5950f39e4d2ce0b793',
  },
  'darwin-x64': {
    url: `https://github.com/asg017/sqlite-vec/releases/download/v${VEC0_VERSION}/sqlite-vec-${VEC0_VERSION}-loadable-macos-x86_64.tar.gz`,
    tarballSha256: '53ad76e400786515e2edcaed2f01271dda846316390b761fadbd2dcf56aa4713',
    member: 'vec0.dylib',
    fileSha256: 'd39d33d16d302d57440d9a9cdbe3cc095e8324aa96b979b5171f545a6346996d',
  },
  'linux-x64': {
    url: `https://github.com/asg017/sqlite-vec/releases/download/v${VEC0_VERSION}/sqlite-vec-${VEC0_VERSION}-loadable-linux-x86_64.tar.gz`,
    tarballSha256: 'b959baa1d8dc88861b1edb337b8587178cdcb12d60b4998f9d10b6a82052d5d7',
    member: 'vec0.so',
    fileSha256: '5923730861b86c707cca5602b5f91092f9e52a46706dbc6e269fd4bb9c4498e8',
  },
  'linux-arm64': {
    url: `https://github.com/asg017/sqlite-vec/releases/download/v${VEC0_VERSION}/sqlite-vec-${VEC0_VERSION}-loadable-linux-aarch64.tar.gz`,
    tarballSha256: 'ea03d39541e478fab5974253c461e1cb5d77742f69e40cf96e3fad5bc309a37c',
    member: 'vec0.so',
    fileSha256: '0b84cbd06418ca3040827deddd650539be05be0f657952426b926c8606217437',
  },
  'win32-x64': {
    url: `https://github.com/asg017/sqlite-vec/releases/download/v${VEC0_VERSION}/sqlite-vec-${VEC0_VERSION}-loadable-windows-x86_64.tar.gz`,
    tarballSha256: '51581189d52066b4dfc6631f6d7a3eab7dedc2260656ab09ca97ab3fb8165983',
    member: 'vec0.dll',
    fileSha256: 'fcf98662a7ad9dce394b96a88f91032047823831b951c76636787c312a6476e6',
  },
}

/** The pinned build for this platform and architecture; null where the release has none. */
export function vec0AssetFor(platform: string, arch: string): Vec0Asset | null {
  return VEC0_ASSETS[`${platform}-${arch}`] ?? null
}

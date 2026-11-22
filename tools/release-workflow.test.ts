// Pins the shape of the tag-triggered release workflow. Like the smoke workflow
// test, it reads the YAML as text so no YAML parser joins the dev dependencies.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NPM_TARGETS } from './pack-npm'

const WORKFLOWS = join(import.meta.dir, '..', '.github', 'workflows')
const release = (): string => readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')

/** The text of one top-level job, from its key to the next job key. */
function job(text: string, name: string): string {
  const jobs = text.slice(text.indexOf('\njobs:'))
  const start = jobs.search(new RegExp(`^  ${name}:\\s*$`, 'm'))
  expect(start).toBeGreaterThan(-1)
  const rest = jobs.slice(start + 1)
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$/m)
  return next === -1 ? rest : rest.slice(0, next)
}

describe('release workflow', () => {
  test('release.yml runs on v tags, pushed or dispatched by the version workflow', () => {
    const text = release()
    expect(text).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n {2}workflow_dispatch:\n/m)
    expect(text).not.toContain('pull_request')
    // A dispatch on a branch named like a version must not release that branch.
    expect(job(text, 'check')).toContain('REF_TYPE: ${{ github.ref_type }}')
    expect(job(text, 'check')).toContain('if [ "$REF_TYPE" != "tag" ]')
  })

  test('release.yml defaults to no permissions, and only npm-publish has id-token: write', () => {
    const text = release()
    expect(text).toMatch(/^permissions: \{\}\s*$/m)
    expect([...text.matchAll(/id-token: write/g)]).toHaveLength(1)
    expect(job(text, 'npm-publish')).toContain('id-token: write')
    // Only the jobs that create, promote or discard the Release may write to the repo.
    for (const name of ['github-release', 'promote', 'discard']) expect(job(text, name)).toContain('contents: write')
    expect([...text.matchAll(/contents: write/g)]).toHaveLength(3)
  })

  test('release.yml smoke-tests the real prerelease before it is promoted and published', () => {
    const text = release()
    // A final build checks itself against its own GitHub Release, so the Release must exist before the smoke.
    expect(job(text, 'build')).toContain('skip_smoke: true')
    expect(job(text, 'github-release')).toContain('--prerelease')
    const smoke = job(text, 'smoke')
    expect(smoke).toContain('uses: ./.github/workflows/smoke.yml')
    expect(smoke).toContain('needs: [check, github-release]')
    const promote = job(text, 'promote')
    expect(promote).toContain('needs: [check, smoke]')
    expect(promote).toContain('gh release edit "v$VERSION" --prerelease=false --latest')
    expect(job(text, 'npm-publish')).toContain('needs: [check, build, promote]')
    const discard = job(text, 'discard')
    // A cancelled smoke must not leave an untested prerelease behind either.
    expect(discard).toContain("if: (failure() || cancelled()) && needs.github-release.result == 'success'")
    expect(discard).toContain('gh release delete "v$VERSION" --yes')
    expect(discard).not.toContain('--cleanup-tag')
  })

  test('release-build.yml smoke-tests unless its caller runs the smoke itself', () => {
    const called = readFileSync(join(WORKFLOWS, 'release-build.yml'), 'utf8')
    expect(called).toMatch(/^ {6}skip_smoke:\n/m)
    const smokeJob = called.slice(called.indexOf('\n  smoke:'))
    expect(smokeJob).toContain('if: ${{ !inputs.skip_smoke }}')
  })

  test('release.yml checks the tag is a release version on main, or a prerelease on beta', () => {
    const check = job(release(), 'check')
    expect(check).toContain('fetch-depth: 0')
    expect(check).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')
    expect(check).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/beta')
    expect(check).toContain('PRERELEASE: ${{ steps.version.outputs.prerelease }}')
    expect(check).toContain('0.0.0-dev')
  })

  test("release.yml calls release-build.yml with the tag's version", () => {
    const text = release()
    const build = job(text, 'build')
    expect(build).toContain('uses: ./.github/workflows/release-build.yml')
    expect(build).toContain('version: ${{ needs.check.outputs.version }}')
    const called = readFileSync(join(WORKFLOWS, 'release-build.yml'), 'utf8')
    expect(called).toMatch(/^ {2}workflow_call:\n {4}inputs:\n {6}version:\n/m)
  })

  test('release.yml makes the GitHub Release before it publishes to npm', () => {
    const text = release()
    const github = job(text, 'github-release')
    expect(github).toContain('sha256sum --check SHA256SUMS')
    expect(github).toContain('scripts/install.sh')
    expect(github).toContain('scripts/install.ps1')
    expect(github).toContain('gh release create "v$VERSION"')
    expect(github).toContain('--verify-tag')
    expect(github).toContain('bun tools/release-notes.ts dist "$VERSION"')
    expect(github).toContain('--notes-file "$RUNNER_TEMP/RELEASE_NOTES.md"')
    // The notes are moved out before dist/* is uploaded, so they never become an asset.
    expect(github.indexOf('mv dist/RELEASE_NOTES.md')).toBeLessThan(github.indexOf('gh release create'))
    expect(job(text, 'npm-publish')).toContain('needs: [check, build, promote]')
  })

  test('release.yml publishes the five cli packages before the launcher', () => {
    const npm = job(release(), 'npm-publish')
    expect(npm).toContain('sha256sum --check SHA256SUMS')
    expect(npm).toContain('bun tools/pack-npm.ts dist "$VERSION"')
    const order = [...npm.matchAll(/dist\/npm\/([\w-]+)/g)].map((match) => match[1])
    expect(order).toEqual([...NPM_TARGETS.map((target) => target.dir), 'kinfold'])
    expect([...npm.matchAll(/npm publish --provenance --access public/g)].length).toBeGreaterThan(0)
  })

  test('release.yml pins the exact npm that runs with the OIDC token', () => {
    const npm = job(release(), 'npm-publish')
    expect(npm).toMatch(/npm install -g npm@\d+\.\d+\.\d+\s/)
    expect(npm).not.toContain('npm@latest')
  })

  test('release.yml never names an npm token', () => {
    const text = release()
    expect(text).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|\.npmrc/)
    expect(text).not.toContain('secrets.')
  })
})

describe('version workflow', () => {
  const version = (): string => readFileSync(join(WORKFLOWS, 'version.yml'), 'utf8')

  test('version.yml runs on pushes to main and beta, one run at a time', () => {
    const text = version()
    expect(text).toMatch(/^on:\n {2}push:\n {4}branches:\n {6}- main\n {6}- beta\n/m)
    expect(text).toMatch(/^permissions: \{\}\s*$/m)
    expect(text).toContain('cancel-in-progress: false')
    expect(text).not.toContain('secrets.')
    expect(text).not.toContain('id-token')
  })

  test('version.yml tags an untagged version and dispatches release.yml on the tag', () => {
    const tag = job(version(), 'tag')
    expect(tag).toContain('actions: write')
    expect(tag).toContain('contents: write')
    expect(tag).toContain('bun tools/changesets.ts plan')
    expect(tag).toContain('git push origin "refs/tags/v$VERSION"')
    expect(tag).toContain('gh workflow run release.yml --ref "v$VERSION"')
    // The tag goes on the commit that set the version, even when a later push's run gets there first.
    expect(tag).toContain("git log -1 --format=%H -G'\"version\":' -- package.json")
    expect(tag).toContain('git tag "v$VERSION" "$commit"')
    // A tag whose release never started (the dispatch failed) is dispatched again on the next run.
    expect(tag).toContain('gh run list --workflow release.yml --branch "v$VERSION"')
    expect(tag).toContain('=~ ^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$')
    // beta only makes prereleases; finals come from main.
    expect(tag).toContain('if [ "$BRANCH" = "beta" ] && [[ "$VERSION" != *-* ]]')
    expect(tag.indexOf('git push origin')).toBeLessThan(tag.indexOf('gh workflow run'))
  })

  test('version.yml opens or updates one Version PR from changeset version', () => {
    const pr = job(version(), 'version-pr')
    expect(pr).toContain('pull-requests: write')
    expect(pr).toContain("if: needs.tag.outputs.pending != '0'")
    expect(pr).toContain('bunx changeset version')
    // A rerun of an old run must not rebuild the Version PR from a stale commit.
    expect(pr).toContain('git ls-remote origin "refs/heads/$BRANCH"')
    expect(pr).toContain('changeset-release/$BRANCH')
    expect(pr).toContain('--title "Version $NEXT"')
    // A short body: one line per changeset, and a link to the full notes.
    expect(pr).toContain('bun tools/changesets.ts digest "$NEXT"')
    expect(pr).toContain('blob/$head/CHANGELOG.md')
    expect(pr).toContain("git commit -m \"chore: version $NEXT\"")
    expect(pr).not.toMatch(/Co-Authored-By|Claude/i)
  })
})

describe('ci changeset check', () => {
  test('ci.yml runs the changeset check on pull requests against the base branch', () => {
    const ci = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8')
    const check = job(ci, 'changeset')
    expect(check).toContain("if: github.event_name == 'pull_request'")
    expect(check).toContain('fetch-depth: 0')
    expect(check).toContain('bun tools/changesets.ts check "origin/$GITHUB_BASE_REF"')
  })
})

describe('release environment', () => {
  // Each publishing job waits in the 'release' environment for the maintainer's
  // approval; npm's trusted publisher is pinned to it too.
  test('only the jobs that publish run in the release environment', () => {
    const text = release()
    for (const name of ['github-release', 'promote', 'npm-publish']) expect(job(text, name)).toMatch(/^ {4}environment: release$/m)
    // Builds, the smoke and the cleanup of a failed prerelease never wait for approval.
    for (const name of ['check', 'build', 'smoke', 'discard']) expect(job(text, name)).not.toContain('environment:')
    expect([...text.matchAll(/^ {4}environment:/gm)]).toHaveLength(3)
  })
})

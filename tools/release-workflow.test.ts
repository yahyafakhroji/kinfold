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
  test('release.yml runs on v tags only', () => {
    const text = release()
    expect(text).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n/m)
    expect(text).not.toContain('workflow_dispatch')
    expect(text).not.toContain('pull_request')
  })

  test('release.yml defaults to no permissions, and only npm-publish has id-token: write', () => {
    const text = release()
    expect(text).toMatch(/^permissions: \{\}\s*$/m)
    expect([...text.matchAll(/id-token: write/g)]).toHaveLength(1)
    expect(job(text, 'npm-publish')).toContain('id-token: write')
    expect(job(text, 'github-release')).toContain('contents: write')
    expect([...text.matchAll(/contents: write/g)]).toHaveLength(1)
  })

  test('release.yml checks the tag is a release version on main', () => {
    const check = job(release(), 'check')
    expect(check).toContain('fetch-depth: 0')
    expect(check).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')
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
    expect(job(text, 'npm-publish')).toContain('needs: [check, build, github-release]')
  })

  test('release.yml publishes the five cli packages before the launcher', () => {
    const npm = job(release(), 'npm-publish')
    expect(npm).toContain('sha256sum --check SHA256SUMS')
    expect(npm).toContain('bun tools/pack-npm.ts dist "$VERSION"')
    const order = [...npm.matchAll(/dist\/npm\/([\w-]+)/g)].map((match) => match[1])
    expect(order).toEqual([...NPM_TARGETS.map((target) => target.dir), 'kinfold'])
    expect([...npm.matchAll(/npm publish --provenance --access public/g)].length).toBeGreaterThan(0)
  })

  test('release.yml never names an npm token', () => {
    const text = release()
    expect(text).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken|\.npmrc/)
    expect(text).not.toContain('secrets.')
  })
})

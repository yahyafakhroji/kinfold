import { expect, test } from 'bun:test'
import { MAX_CHANGE_CHARS, MAX_CHANGE_LINES, changeLines, isDevVersion, releaseFromGithub, releaseKind } from '../../update/release'

const gh = (tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ tag_name: tag, draft: false, prerelease: tag.includes('-'), body: '', ...extra })

test('a GitHub release becomes its version, prerelease flag and change lines', () => {
  const body = '## Changes\n\n### Minor Changes\n\n- abc1234: New thing.\n\n## Install\n\nnpx kinfold'
  expect(releaseFromGithub(gh('v0.6.0', { body }))).toEqual({ version: '0.6.0', prerelease: false, changes: ['New thing.'], breaking: [] })
})

test('drafts, tags that are not v<semver>, and non-objects are not releases', () => {
  expect(releaseFromGithub(gh('v0.6.0', { draft: true }))).toBeNull()
  expect(releaseFromGithub(gh('0.6.0'))).toBeNull()
  expect(releaseFromGithub(gh('vnext'))).toBeNull()
  expect(releaseFromGithub(null)).toBeNull()
  expect(releaseFromGithub([])).toBeNull()
})

test('a final version still marked prerelease is in its smoke test and is not a release yet', () => {
  expect(releaseFromGithub(gh('v0.6.0', { prerelease: true }))).toBeNull()
})

test('a build from a checkout is a development version', () => {
  expect(isDevVersion('0.0.0-dev')).toBe(true)
  expect(isDevVersion('0.6.0-dev')).toBe(true)
  expect(isDevVersion('0.6.0-beta.1')).toBe(false)
  expect(isDevVersion('0.6.0')).toBe(false)
})

test('a patch installs itself; anything bigger waits for a yes', () => {
  expect(releaseKind('0.5.0', '0.5.1')).toBe('patch')
  expect(releaseKind('0.5.0', '0.6.0')).toBe('minor')
  expect(releaseKind('0.5.0', '1.0.0')).toBe('major')
  expect(releaseKind('0.5.0', '0.6.0-beta.1')).toBe('prerelease')
  expect(releaseKind('0.6.0-beta.1', '0.6.0')).toBe('minor')
  expect(releaseKind('0.6.0-beta.1', '0.6.0-beta.2')).toBe('prerelease')
})

test('change lines: breaking first, from major entries and BREAKING: lines; nested bullets stay with their entry', () => {
  const body = [
    '## Changes',
    '',
    '### Major Changes',
    '',
    '- 1111111: Renamed the data folder.',
    '',
    '### Minor Changes',
    '',
    '- 2222222: Everything merged:',
    '  ',
    '  - a nested line',
    '- BREAKING: `kinfold size` prints bytes.',
    '',
    '### Patch Changes',
    '',
    '- 3333333: A fix.',
    '',
    '## Install',
    '- not a change',
  ].join('\n')
  expect(changeLines(body)).toEqual({ changes: ['Renamed the data folder.', 'BREAKING: `kinfold size` prints bytes.', 'Everything merged:', 'A fix.'], breaking: ['Renamed the data folder.', 'BREAKING: `kinfold size` prints bytes.'] })
})

test('a release with no changelog has no change lines', () => {
  expect(changeLines('## Changes\n\nNo changelog for this release.\n\n## Install\n')).toEqual({ changes: [], breaking: [] })
  expect(changeLines('')).toEqual({ changes: [], breaking: [] })
  expect(changeLines(42)).toEqual({ changes: [], breaking: [] })
})

test('change lines are capped in count and length, and stripped of control characters', () => {
  const many = ['## Changes', '', ...Array.from({ length: MAX_CHANGE_LINES + 5 }, (_, i) => `- ${'x'.repeat(MAX_CHANGE_CHARS + 50)}${i}\u001b[31m`)].join('\n')
  const { changes } = changeLines(many)
  expect(changes).toHaveLength(MAX_CHANGE_LINES)
  expect(changes.every((line) => line.length <= MAX_CHANGE_CHARS && !line.includes('\u001b'))).toBe(true)
})

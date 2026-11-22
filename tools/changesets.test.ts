import { describe, expect, test } from 'bun:test'
import { changelogDigest, changelogSection, changesetNeeded, checkPullRequest, parseNameStatus, pendingChangesets, validateChangeset } from './changesets'

describe('pendingChangesets', () => {
  test('counts every changeset file except the ones changesets ignores', () => {
    expect(pendingChangesets(['README.md', 'readme.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.hidden.md', 'config.json', 'brave-owls.md', 'calm-cats.md'], [], null))
      .toEqual(['brave-owls', 'calm-cats'])
  })

  // changesets 3 moves a changeset a prerelease used into .changeset/pre/.
  test('in pre mode, the changesets a beta already used are not pending', () => {
    expect(pendingChangesets(['calm-cats.md', 'pre.json'], ['brave-owls.md'], { mode: 'pre' })).toEqual(['calm-cats'])
  })

  test('after pre exit, or once beta merges to main without pre.json, the used ones are pending again', () => {
    expect(pendingChangesets([], ['brave-owls.md'], { mode: 'exit' })).toEqual(['pre/brave-owls'])
    expect(pendingChangesets([], ['brave-owls.md'], null)).toEqual(['pre/brave-owls'])
  })
})

describe('changesetNeeded', () => {
  test('a change to shipped code or packaging needs a changeset', () => {
    for (const path of ['src/cli/kinfold.ts', 'scripts/install.sh', 'tools/pack-npm.ts', 'npm/kinfold/launcher.js', 'package.json', 'bun.lock', '.bun-version']) {
      expect(changesetNeeded([path])).toBe(true)
    }
  })

  test('docs, tests, workflows and changesets alone do not', () => {
    expect(changesetNeeded(['README.md', 'src/cli/kinfold.test.ts', 'tools/smoke.test.ts', 'test/fixtures/a.json', '.github/workflows/ci.yml', '.changeset/x.md'])).toBe(false)
  })
})

describe('validateChangeset', () => {
  test('accepts kinfold with a bump type, quoted or not, and an empty changeset', () => {
    expect(validateChangeset('---\n"kinfold": minor\n---\n\nAdd a thing.\n')).toBeNull()
    expect(validateChangeset("---\n'kinfold': patch\n---\n\nFix a thing.\n")).toBeNull()
    expect(validateChangeset('---\nkinfold: major\n---\n\nBREAKING: drop a thing.\n')).toBeNull()
    expect(validateChangeset('---\n---\n')).toBeNull()
  })

  test('refuses another package, a bad bump, a missing summary or no front matter', () => {
    expect(validateChangeset('---\n"@kinfold/cli-linux-x64": patch\n---\n\nx\n')).toContain('@kinfold/cli-linux-x64')
    expect(validateChangeset('---\n"kinfold": huge\n---\n\nx\n')).toContain('huge')
    expect(validateChangeset('---\n"kinfold": patch\n---\n\n')).toContain('summary')
    expect(validateChangeset('Fix a thing.\n')).toContain('front matter')
  })
})

describe('parseNameStatus', () => {
  test('reads git diff --name-status lines', () => {
    expect(parseNameStatus('A\t.changeset/x.md\nM\tsrc/a.ts\nD\told.ts\n')).toEqual([
      { status: 'A', path: '.changeset/x.md' },
      { status: 'M', path: 'src/a.ts' },
      { status: 'D', path: 'old.ts' },
    ])
  })
})

describe('checkPullRequest', () => {
  const read = (texts: Record<string, string>) => (path: string): string => texts[path] ?? ''
  const base = { headRef: 'fix/thing', baseRef: 'main' }

  test('fails a code change with no changeset and says how to add one', () => {
    const result = checkPullRequest({ ...base, files: [{ status: 'M', path: 'src/a.ts' }], read: read({}) })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('bunx changeset')
  })

  test('passes a code change with a valid changeset', () => {
    const result = checkPullRequest({
      ...base,
      files: [{ status: 'M', path: 'src/a.ts' }, { status: 'A', path: '.changeset/brave-owls.md' }],
      read: read({ '.changeset/brave-owls.md': '---\n"kinfold": patch\n---\n\nFix a thing.\n' }),
    })
    expect(result).toEqual({ ok: true, message: 'changeset: .changeset/brave-owls.md' })
  })

  test('editing a changeset already on the base branch does not count as adding one', () => {
    const result = checkPullRequest({
      ...base,
      files: [{ status: 'M', path: 'src/a.ts' }, { status: 'M', path: '.changeset/brave-owls.md' }],
      read: read({ '.changeset/brave-owls.md': '---\n"kinfold": patch\n---\n\nFix a thing.\n' }),
    })
    expect(result.ok).toBe(false)
  })

  test('fails an invalid changeset even when none was needed', () => {
    const result = checkPullRequest({ ...base, files: [{ status: 'A', path: '.changeset/x.md' }], read: read({ '.changeset/x.md': '---\n"kinfold": huge\n---\n\nx\n' }) })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('.changeset/x.md')
  })

  test('passes a docs-only change with no changeset', () => {
    expect(checkPullRequest({ ...base, files: [{ status: 'M', path: 'README.md' }], read: read({}) }).ok).toBe(true)
  })

  test('the Version PR is exempt, since it consumes the changesets', () => {
    const files = [{ status: 'M', path: 'package.json' }, { status: 'D', path: '.changeset/x.md' }]
    expect(checkPullRequest({ headRef: 'changeset-release/main', baseRef: 'main', files, read: read({}) }).ok).toBe(true)
  })

  test('main never enters pre mode', () => {
    const files = [{ status: 'A', path: '.changeset/pre.json' }]
    const result = checkPullRequest({ ...base, files, read: read({}) })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('beta')
    expect(checkPullRequest({ headRef: 'x', baseRef: 'beta', files, read: read({}) }).ok).toBe(true)
  })
})

describe('changelogSection', () => {
  const changelog = '# kinfold\n\n## 0.6.0-beta.1\n\n### Minor Changes\n\n- abc1234: Add b.\n\n## 0.5.0\n\n### Minor Changes\n\n- def5678: Add a.\n'

  test('returns the body under the version heading, up to the next version', () => {
    expect(changelogSection(changelog, '0.6.0-beta.1')).toBe('### Minor Changes\n\n- abc1234: Add b.')
    expect(changelogSection(changelog, '0.5.0')).toBe('### Minor Changes\n\n- def5678: Add a.')
  })

  test('returns null for a version with no section', () => {
    expect(changelogSection(changelog, '0.4.0')).toBeNull()
    expect(changelogSection('', '0.5.0')).toBeNull()
  })
})

describe('changelogDigest', () => {
  test('keeps the headings and cuts each entry to its commit and first sentence', () => {
    const section = [
      '### Patch Changes',
      '',
      '- abc1234: The remaining fixes from the 0.6.0 audit. Most of them make Kinfold do less work.',
      '  ',
      '  `kinfold findings --purge <id>` finds a pending finding however old it is.',
      '- def5678: BREAKING: security fixes. Four things you may notice!',
      '- 0123abc: One sentence with no stop',
      '',
      '### Minor Changes',
      '',
      '- 4567def: Add a page? It shows things.',
    ].join('\n')
    expect(changelogDigest(section)).toBe([
      '### Patch Changes',
      '',
      '- abc1234: The remaining fixes from the 0.6.0 audit.',
      '- def5678: BREAKING: security fixes.',
      '- 0123abc: One sentence with no stop',
      '',
      '### Minor Changes',
      '',
      '- 4567def: Add a page?',
    ].join('\n'))
  })
})

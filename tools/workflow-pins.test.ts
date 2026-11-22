// Every action a workflow runs is pinned to a commit, and a job that never
// pushes does not leave the token in .git/config. Reads the YAML as text, like
// the other workflow tests.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const GITHUB = join(import.meta.dir, '..', '.github')

/** Every workflow and composite action file, by its path under .github. */
function files(): { name: string; text: string }[] {
  const workflows = readdirSync(join(GITHUB, 'workflows')).filter((name) => name.endsWith('.yml')).map((name) => join('workflows', name))
  const actions = readdirSync(join(GITHUB, 'actions')).map((name) => join('actions', name, 'action.yml'))
  return [...workflows, ...actions].map((name) => ({ name, text: readFileSync(join(GITHUB, name), 'utf8') }))
}

/** The workflows whose jobs push with git, so their checkout keeps the token. */
const PUSHING = new Set([join('workflows', 'version.yml')])

describe('workflow pins', () => {
  test('every action is pinned to a full commit SHA with its version in a comment', () => {
    const uses = files().flatMap((file) => [...file.text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)].map((match) => ({ file: file.name, target: match[1]!, rest: match[2]! })))
    const remote = uses.filter((use) => !use.target.startsWith('./'))
    expect(remote.length).toBeGreaterThan(10)
    for (const use of remote) expect(`${use.file}: ${use.target}${use.rest}`).toMatch(/: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
  })

  test('a checkout keeps its credentials only in a workflow that pushes', () => {
    for (const file of files()) {
      const checkouts = [...file.text.matchAll(/^(\s*)- uses: actions\/checkout@.*\n((?:\1 {2}.*\n)*)/gm)].map((match) => match[2]!)
      for (const block of checkouts) expect(`${file.name}: ${block.includes('persist-credentials: false')}`).toBe(`${file.name}: ${!PUSHING.has(file.name)}`)
    }
    // version.yml is the one that pushes: a tag in one job, a branch in the other.
    const version = readFileSync(join(GITHUB, 'workflows', 'version.yml'), 'utf8')
    expect(version).toContain('git push origin "refs/tags/v$VERSION"')
    expect(version).toContain('git push --force origin "$head"')
  })
})

import { expect, test } from 'bun:test'
import { launchdPath } from './launch-agent'

const BUN = '/opt/bun/bin/bun'
const SYSTEM = '/usr/bin:/bin:/usr/sbin:/sbin'

function whichFrom(found: Record<string, string>): (command: string) => string | null {
  return (command) => found[command] ?? null
}

test('the plist PATH adds the dirs of codex, the node it runs on, and opencode, in a stable deduplicated order', () => {
  const which = whichFrom({
    claude: '/home/u/.local/bin/claude',
    git: '/opt/homebrew/bin/git',
    codex: '/home/u/.npm-global/bin/codex',
    node: '/home/u/.nvm/versions/node/v22/bin/node',
    opencode: '/home/u/.opencode/bin/opencode',
  })
  const expected = [
    '/opt/bun/bin',
    '/home/u/.local/bin',
    '/opt/homebrew/bin',
    '/home/u/.npm-global/bin',
    '/home/u/.nvm/versions/node/v22/bin',
    '/home/u/.opencode/bin',
    SYSTEM,
  ].join(':')
  expect(launchdPath({ bunPath: BUN, pathEnv: '/anything' }, which)).toBe(expected)
})

test('a CLI in a dir already on the plist PATH adds no second entry', () => {
  const which = whichFrom({
    claude: '/opt/homebrew/bin/claude',
    git: '/opt/homebrew/bin/git',
    codex: '/opt/homebrew/bin/codex',
    node: '/opt/homebrew/bin/node',
    opencode: '/opt/homebrew/bin/opencode',
  })
  expect(launchdPath({ bunPath: BUN, pathEnv: '/anything' }, which)).toBe(`/opt/bun/bin:/opt/homebrew/bin:${SYSTEM}`)
})

test('without codex or opencode on PATH the plist PATH is unchanged, and node is not added on its own', () => {
  const which = whichFrom({
    claude: '/home/u/.local/bin/claude',
    git: '/opt/homebrew/bin/git',
    node: '/home/u/.nvm/versions/node/v22/bin/node',
  })
  expect(launchdPath({ bunPath: BUN, pathEnv: '/anything' }, which)).toBe(`/opt/bun/bin:/home/u/.local/bin:/opt/homebrew/bin:${SYSTEM}`)
})

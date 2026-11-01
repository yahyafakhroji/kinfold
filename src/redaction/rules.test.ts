import { describe, expect, test } from 'bun:test'
import { SECRET_KEY_NAME, isSensitiveCommand, isSensitivePath, looksLikeSecretValue, looksRandom, shannonEntropy } from './rules'

describe('isSensitivePath', () => {
  test.each([
    '.env',
    '/repo/.env.local',
    'apps/web/.env.production',
    '/home/dev/.ssh/id_ed25519',
    'certs/server.pem',
    'deploy/prod.tfvars',
    '/home/dev/.npmrc',
    '/home/dev/.aws/credentials',
    '/home/dev/.kube/config',
    'C:\\Users\\dev\\.docker\\config.json',
  ])('withholds %s', (path) => {
    expect(isSensitivePath(path)).toBe(true)
  })

  test.each(['.env.example', '/repo/.env.sample', '/home/dev/.ssh/id_ed25519.pub', 'src/keys.ts', 'README.md', 'src/env.ts'])(
    'keeps %s',
    (path) => {
      expect(isSensitivePath(path)).toBe(false)
    },
  )

  test('honors extra patterns from .memignore', () => {
    expect(isSensitivePath('/repo/secrets/prod.yaml', [/(^|\/)secrets\//])).toBe(true)
  })
})

describe('isSensitiveCommand', () => {
  test.each([
    'printenv',
    'env',
    'env | grep AWS',
    'export -p',
    'set',
    'printenv GITHUB_TOKEN',
    'cat .env',
    'rtk read /Users/dev/repo/.env',
    'grep DATABASE < .env.local',
    'source .env && node app.js',
    'echo $(cat ~/.aws/credentials)',
    'gh auth token',
    'aws configure get aws_secret_access_key',
    'kubectl get secret db -o yaml',
    'kubectl -n prod get secret db',
    'echo $GITHUB_TOKEN',
    'curl -H "Authorization: Bearer ${API_TOKEN}" https://api.example.com',
  ])('withholds %s', (command) => {
    expect(isSensitiveCommand(command)).toBe(true)
  })

  // The first five are the commands the recorded Claude Code and OpenCode sessions ran.
  test.each([
    'rtk read /Users/dev/repo/.env.example',
    'cat .env.example',
    'ls -a | rtk grep -i env',
    'bun test 2>&1 | tail -40',
    'bun test',
    'env NODE_ENV=test bun test',
    'printenv PATH',
    'export NODE_ENV=production',
    'jq .key package.json',
    'echo $PATH',
    'gh pr list',
    'kubectl get pods',
    'git log --oneline',
  ])('keeps %s', (command) => {
    expect(isSensitiveCommand(command)).toBe(false)
  })
})

describe('SECRET_KEY_NAME', () => {
  test.each(['API_KEY', 'DATABASE_PASSWORD', 'github_token', 'client_secret', 'db_pwd', 'aws_access_key_id'])('matches %s', (name) => {
    expect(SECRET_KEY_NAME.test(name)).toBe(true)
  })

  test.each(['author', 'PWD', 'keyboard', 'monkey'])('ignores %s', (name) => {
    expect(SECRET_KEY_NAME.test(name)).toBe(false)
  })
})

describe('looksLikeSecretValue', () => {
  test('rejects config-shaped values', () => {
    for (const value of ['4096', 'true', '$GITHUB_TOKEN', '{{ secrets.TOKEN }}', 'short']) {
      expect(looksLikeSecretValue(value)).toBe(false)
    }
    expect(looksLikeSecretValue('hunter2-Prod-77')).toBe(true)
  })
})

describe('looksRandom', () => {
  test('flags mixed random strings and leaves words alone', () => {
    expect(looksRandom('Qm9vT3h2Zk1xR3p4WnY5Ty8rL2Vh', 'keyed')).toBe(true)
    expect(looksRandom('shared_agent_memory_component_name', 'keyed')).toBe(false)
  })

  test('treats hex as random only in strict mode', () => {
    const commit = '3f9c2a7b1d4e5f60718293a4b5c6d7e8f9012345'
    expect(looksRandom(commit, 'keyed')).toBe(false)
    expect(looksRandom(commit, 'strict')).toBe(true)
  })

  test('computes Shannon entropy in bits per character', () => {
    expect(shannonEntropy('aaaa')).toBe(0)
    expect(shannonEntropy('abcd')).toBe(2)
  })
})

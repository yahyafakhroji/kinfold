import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

test('the repository is Apache-2.0 with the Kinfold notice', () => {
  const license = readFileSync(join(root, 'LICENSE'), 'utf8');
  expect(license).toContain('Apache License');
  expect(license).toContain('Version 2.0, January 2004');

  const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
  expect(notice).toBe('Kinfold\n\nCopyright 2026 Yahya Fakhroji\n');

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  expect(pkg.name).toBe('kinfold');
  expect(pkg.license).toBe('Apache-2.0');
});

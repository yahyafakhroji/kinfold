import { expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import { BuildError, buildSqlite3mc, compileCommand, zipMembers } from './build'

interface Entry { name: string; data: Uint8Array; deflate?: boolean }

/** A minimal zip: local headers, then the central directory, then the end record. */
function zip(entries: readonly Entry[]): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name)
    const body = entry.deflate === true ? new Uint8Array(deflateRawSync(entry.data)) : entry.data
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(8, entry.deflate === true ? 8 : 0, true)
    local.setUint32(18, body.length, true)
    local.setUint32(22, entry.data.length, true)
    local.setUint16(26, name.length, true)
    parts.push(new Uint8Array(local.buffer), name, body)
    const record = new DataView(new ArrayBuffer(46))
    record.setUint32(0, 0x02014b50, true)
    record.setUint16(10, entry.deflate === true ? 8 : 0, true)
    record.setUint32(20, body.length, true)
    record.setUint32(24, entry.data.length, true)
    record.setUint16(28, name.length, true)
    record.setUint32(42, offset, true)
    central.push(new Uint8Array(record.buffer), name)
    offset += 30 + name.length + body.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of all) { out.set(part, at); at += part.length }
  return out
}

const text = (s: string) => new TextEncoder().encode(s)

test('only the named members come out, stored or deflated, and nothing else is read', () => {
  const archive = zip([{ name: 'a.c', data: text('int a;') }, { name: 'b.h', data: text('#define B 1'.repeat(50)), deflate: true }, { name: '../evil', data: text('x') }])
  const members = zipMembers(archive, ['a.c', 'b.h'])
  expect([...members.keys()]).toEqual(['a.c', 'b.h'])
  expect(new TextDecoder().decode(members.get('b.h'))).toBe('#define B 1'.repeat(50))
})

test('a missing member, a file that is not a zip, or a truncated one fails with a BuildError', () => {
  const archive = zip([{ name: 'a.c', data: text('int a;') }])
  expect(() => zipMembers(archive, ['a.c', 'missing.h'])).toThrow('zip lacks missing.h')
  expect(() => zipMembers(text('not a zip at all, just some bytes here'), ['a.c'])).toThrow(BuildError)
  expect(() => zipMembers(archive.subarray(20), ['a.c'])).toThrow(BuildError)
})

test('the build refuses a zip that is not the pinned one before it writes anything', () => {
  expect(() => buildSqlite3mc({ zip: text('x'), workDir: '/nonexistent/never-created', output: '/nonexistent/out' })).toThrow('does not match the pinned sha256')
})

test('compile commands exist for macOS and Linux only, with FTS5 and dbstat on', () => {
  const mac = compileCommand('darwin', 'in.c', 'out', 'cc')!
  expect(mac.slice(0, 2)).toEqual(['cc', '-dynamiclib'])
  expect(mac).toContain('-DSQLITE_ENABLE_FTS5')
  expect(mac).toContain('-DSQLITE_ENABLE_DBSTAT_VTAB')
  expect(compileCommand('linux', 'in.c', 'out', 'cc')).toContain('-Wl,-Bsymbolic')
  expect(compileCommand('win32', 'in.c', 'out', 'cc')).toBeNull()
})

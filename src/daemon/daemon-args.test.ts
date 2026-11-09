import { expect, test } from 'bun:test'
import { SHUTDOWN_SIGNALS, parseDaemonArgs, shutdownSignalsFor } from './daemon-args'
import { currentPlatform } from '../platform/platform'

test('daemon flags', () => {
  expect(parseDaemonArgs(['--port', '40000', '--log-file', '/t/d.log'])).toEqual({ port: 40000, logFile: '/t/d.log' })
  expect(parseDaemonArgs([])).toEqual({ port: null, logFile: null })
  expect(() => parseDaemonArgs(['--port', '80'])).toThrow('kinfold daemon: --port takes 1024-65535')
  expect(() => parseDaemonArgs(['--port', 'x'])).toThrow('kinfold daemon: --port takes 1024-65535')
  expect(() => parseDaemonArgs(['--port', '65536'])).toThrow('kinfold daemon: --port takes 1024-65535')
  expect(() => parseDaemonArgs(['--port'])).toThrow('kinfold daemon: --port takes 1024-65535')
  expect(() => parseDaemonArgs(['--verbose'])).toThrow('kinfold daemon: unknown argument --verbose')
  expect(() => parseDaemonArgs(['--log-file', 'logs/daemon.log'])).toThrow('kinfold daemon: --log-file takes an absolute path')
})

test('SIGBREAK is a shutdown signal only on Windows', () => {
  expect(shutdownSignalsFor({ os: 'macos', wsl: false, node: 'darwin' })).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
  expect(shutdownSignalsFor({ os: 'linux', wsl: true, node: 'linux' })).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
  expect(shutdownSignalsFor({ os: 'windows', wsl: false, node: 'win32' })).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'])
  expect(SHUTDOWN_SIGNALS).toEqual(shutdownSignalsFor(currentPlatform()))
})

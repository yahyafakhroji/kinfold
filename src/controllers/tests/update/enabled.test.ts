import { expect, test } from 'bun:test'
import type { InstallRecord } from '../../../resources/install-plan/setup/record'
import { autoUpdateSetting, betaChannelOn } from '../../update/enabled'

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1 }

test('auto-update is on for an install with the update check on', () => {
  expect(autoUpdateSetting('0.2.0', RECORD, {})).toEqual({ on: true })
})

test('turning the update check off turns auto-update off', () => {
  expect(autoUpdateSetting('0.2.0', { ...RECORD, updateCheck: false }, {})).toEqual({ on: false, reason: 'the update check is off' })
  expect(autoUpdateSetting('0.2.0', RECORD, { KINFOLD_NO_UPDATE_CHECK: '1' })).toEqual({ on: false, reason: 'the update check is off' })
  expect(autoUpdateSetting('0.2.0', { ...RECORD, channel: 'checkout' }, {})).toEqual({ on: false, reason: 'the update check is off' })
  expect(autoUpdateSetting('0.0.0-dev', RECORD, {})).toEqual({ on: false, reason: 'the update check is off' })
})

test('the record and the environment each turn it off, and say which', () => {
  expect(autoUpdateSetting('0.2.0', { ...RECORD, autoUpdate: false }, {})).toEqual({ on: false, reason: 'turned off' })
  expect(autoUpdateSetting('0.2.0', RECORD, { KINFOLD_NO_AUTO_UPDATE: '1' })).toEqual({ on: false, reason: 'KINFOLD_NO_AUTO_UPDATE is set' })
  expect(autoUpdateSetting('0.2.0', RECORD, { KINFOLD_NO_AUTO_UPDATE: '0' })).toEqual({ on: true })
})

test('a folder with no install record never updates itself', () => {
  expect(autoUpdateSetting('0.2.0', null, {})).toEqual({ on: false, reason: 'no install record' })
})

test('a running prerelease reads the beta channel even when the record leaves it off', () => {
  expect(betaChannelOn(RECORD, '0.6.0-beta.1')).toBe(true)
  expect(betaChannelOn(null, '0.6.0-beta.1')).toBe(true)
  expect(betaChannelOn(RECORD, '0.6.0')).toBe(false)
  expect(betaChannelOn({ ...RECORD, beta: true }, '0.6.0')).toBe(true)
})

test("a checkout's dev version is not a prerelease", () => {
  expect(betaChannelOn(RECORD, '0.0.0-dev')).toBe(false)
})

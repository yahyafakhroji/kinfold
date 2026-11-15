import { expect, test } from 'bun:test'
import type { InstallRecord } from '../install/setup/record'
import { autoUpdateSetting } from './enabled'

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

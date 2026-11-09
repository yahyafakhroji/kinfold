// The setup answers turned into the install: one plan (wiring, unwiring, the
// store's key, the port, install.json), printed or run, then the encrypt or
// decrypt flow when the answers change encryption on an existing store, then
// the done screen. A dry run prints the plan and the flow it would run after
// it, and changes nothing.

import { join } from 'node:path'
import { DATA_DIR_NAME } from '../../names'
import { DB_KEY_REF } from '../../secrets/credentials'
import { fileState } from '../../sqlite/open'
import { DB_FILE } from '../../store/data-dir'
import { storedDbKey } from '../db-encryption'
import { detectHosts } from '../detect'
import { decryptConfirmed, encryptKeyExists, encryptWithKey, noKeyStoreRefusal } from '../encrypt'
import { type InstallEnv, errorMessage } from '../env'
import {
  type DaemonSituation,
  EXIT_BLOCKED,
  EXIT_FAILED,
  EXIT_OK,
  type InstallOptions,
  buildPlan,
  daemonSituation,
  foreignDaemonMessage,
  reportDetections,
  restartService,
} from '../install'
import { type InstallKeyStore, keyStoreOf, readKeyStore } from '../key-store-choice'
import { ChoiceError, describeInput } from '../observer-choice'
import { runPlan } from '../plan'
import { PromptCancelled } from '../prompt/prompts'
import { type ProgramCheck, checkProgram } from '../self-install'
import type { SetupState } from './prefill'
import type { EncryptionAnswer, SetupAnswers } from './wizard'

/** What install already worked out before the questions; applySetup works it out itself when left out. */
export interface ApplyContext {
  check: ProgramCheck | null
  situation: DaemonSituation
  /** The store install chose for env.dataDir; its record goes in the plan when it was just chosen. */
  keyStore?: InstallKeyStore
}

type Conversion = 'encrypt' | 'decrypt'

function conversionOf(encryption: EncryptionAnswer): Conversion | null {
  if (encryption.kind === 'encrypt-existing') return 'encrypt'
  if (encryption.kind === 'decrypt-existing') return 'decrypt'
  return null
}

/** Refuses, before the plan writes anything, an encryption change that the flow after it would refuse. */
function conversionProblem(env: InstallEnv, conversion: Conversion | null): string | null {
  if (conversion === null) return null
  const store = keyStoreOf(env)
  if (store === null) return noKeyStoreRefusal(env.platform)
  const state = fileState(join(env.dataDir, DB_FILE))
  if (conversion === 'encrypt') {
    if (state !== 'plain') return 'memory.db is not a plaintext store any more; run install again'
    if (store.exists(DB_KEY_REF)) return encryptKeyExists(store)
    return null
  }
  return state === 'encrypted' ? null : 'memory.db is not encrypted any more; run install again'
}

/**
 * After a failed encrypt, whether the recovery code the person just saved
 * belongs to anything: not when memory.db is still plaintext and the key store
 * does not hold that key. Any error here gives no note, so the failure line
 * itself always prints.
 */
function unusedCodeNote(env: InstallEnv, encryption: EncryptionAnswer): string {
  try {
    if (encryption.kind !== 'encrypt-existing' || encryption.key === null) return ''
    if (fileState(join(env.dataDir, DB_FILE)) !== 'plain') return ''
    const stored = storedDbKey(env)
    if (stored.kind === 'usable' && stored.key === encryption.key) return ''
    return '. memory.db was not changed and is still plaintext, so the recovery code shown is not used; discard it'
  } catch {
    return ''
  }
}

async function convert(env: InstallEnv, encryption: EncryptionAnswer): Promise<void> {
  if (encryption.kind === 'encrypt-existing') {
    if (encryption.key === null) throw new Error('no confirmed key to encrypt with')
    await encryptWithKey(env, encryption.key)
  }
  else if (encryption.kind === 'decrypt-existing') await decryptConfirmed(env)
}

async function contextFor(env: InstallEnv, options: InstallOptions, given: ApplyContext | undefined): Promise<ApplyContext> {
  if (given !== undefined) return given
  const situation = await daemonSituation(env)
  const check = await checkProgram(env, { source: options.programSource ?? process.execPath, dryRun: options.dryRun, version: options.releaseVersion })
  return { check, situation }
}

/**
 * Plans and runs one answer set. The encrypt or decrypt flow runs after the
 * plan, through the service control, because it stops the daemon the plan
 * just started; its recovery code was confirmed in the questions already.
 */
export async function applySetup(env: InstallEnv, state: SetupState, answers: SetupAnswers, options: InstallOptions, given?: ApplyContext): Promise<number> {
  try {
    const { check, situation } = await contextFor(env, options, given)
    if (situation.foreign && !options.takeover && !options.dryRun) {
      for (const line of foreignDaemonMessage(situation)) env.out(line)
      return EXIT_BLOCKED
    }
    const conversion = conversionOf(answers.encryption)
    const problem = conversionProblem(env, conversion)
    if (problem !== null) throw new ChoiceError(problem)
    const detections = await detectHosts(env, options.hosts)
    reportDetections(env, detections, answers.hosts)
    for (const choice of answers.observers) {
      env.out(`observer ${choice.input.host}: ${describeInput(choice.input)} (${choice.origin}); ${choice.credentialNote}; check ${choice.check}`)
    }
    const found = detections.filter((detection) => detection.selected && answers.hosts.includes(detection.host))
    const plan = await buildPlan(env, { hosts: answers.hosts, detections: found, situation, keyStore: given?.keyStore }, answers, state, options, check)
    try {
      await runPlan(env, plan.actions, options.dryRun)
    } catch (error: unknown) {
      if (!options.dryRun && plan.stopsService) await restartService(env)
      throw error
    }
    if (options.dryRun) {
      if (conversion !== null) env.out(`then: kinfold ${conversion}`)
      if (!situation.foreign || options.takeover) return EXIT_OK
      for (const line of foreignDaemonMessage(situation)) env.out(line)
      env.out('a real install would stop here, before step 1.')
      return EXIT_BLOCKED
    }
    if (conversion !== null) {
      try {
        await convert(env, answers.encryption)
      } catch (error: unknown) {
        env.out(`install: everything else is in place, but kinfold ${conversion} failed: ${errorMessage(error)}${unusedCodeNote(env, answers.encryption)}`)
        return EXIT_FAILED
      }
    }
    for (const line of doneLines(env, answers, state)) env.out(line)
    return EXIT_OK
  } catch (error: unknown) {
    if (error instanceof PromptCancelled) throw error
    env.out(`install failed: ${errorMessage(error)}`)
    return EXIT_FAILED
  }
}

const quoted = (value: string): string => (/\s/.test(value) ? JSON.stringify(value) : value)

/** What a user types to run Kinfold on this install: the installed program, or the checkout's script, with the folder unless it is the default. */
function commandPrefix(env: InstallEnv): string {
  // Run by hand, either one reads ~/.kinfold unless told otherwise.
  const folder = env.dataDir === join(env.homeDir, DATA_DIR_NAME) ? '' : ` --data-dir ${quoted(env.dataDir)}`
  const program = env.mode.kind === 'checkout' ? 'bun src/cli/kinfold.ts' : quoted(env.mode.binPath)
  return `${program}${folder}`
}

export const SHOW_RECOVERY_LINE = 'Encryption is on: run kinfold key show-recovery in a terminal to see your recovery code.'

/** The done screen: how to check the install and open the dashboard, and what was not shown during it. */
export function doneLines(env: InstallEnv, answers: SetupAnswers, state: SetupState): string[] {
  const run = commandPrefix(env)
  const dropped = state.wiredHosts.filter((host) => !answers.hosts.includes(host))
  const lines = [`installed. Check it with: ${run} status`, `Open the dashboard with: ${run} dashboard`]
  if (dropped.length > 0) lines.push(`No longer wired: ${dropped.join(', ')}.`)
  if (answers.hosts.length === 0) lines.push('No agent is wired; run install again to add one.')
  // Under --yes the key was made, or kept, without its code on screen.
  const unseen = answers.encryption.kind === 'new-encrypted' && answers.encryption.key === null
  const read = readKeyStore(env)
  if (unseen && read.ok && read.store !== null) lines.push(SHOW_RECOVERY_LINE)
  return lines
}

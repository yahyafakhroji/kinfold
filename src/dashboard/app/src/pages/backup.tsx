// Backup: download one file holding everything Kinfold remembers, restore
// one, and switch back after a restore. A restore uploads the file, shows what
// it says about itself, asks for its recovery code when it is encrypted and
// for a confirmation, then follows the daemon until it says how it ended. The
// recovery code goes from its field into the one request and is cleared.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useRef, useState } from 'react'
import { PageHeader } from '../components/page'
import { Button } from '../components/ui/button'
import { Card, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Notice } from '../components/ui/notice'
import { api, errorText, get, uploadFile } from '../lib/api'
import { ago, dateOnly } from '../lib/format'
import { useHubOnly } from '../lib/queries'
import { type RestoreFlow, STATUS_POLL_MS, canRestore, describeManifest, restoreBody, stepText, uploadedRestore } from '../lib/restore'
import type { RestoreStatus } from '../lib/types'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Asks how the restore is going until it ends; reports each step on the way. */
async function follow(onStep: (text: string) => void, undo: boolean): Promise<RestoreStatus> {
  for (;;) {
    const status = await get<RestoreStatus>('/restore/status')
    if (status.state === 'done') return status
    if (status.state !== 'running') throw new Error(status.error ?? (undo ? 'Switching back failed.' : 'The restore failed.'))
    onStep(stepText(status.step, undo))
    await sleep(STATUS_POLL_MS)
  }
}

function BackUp({ lastBackupAt }: { lastBackupAt: number | null | undefined }) {
  return (
    <Card aria-label="Back up">
      <CardTitle>Back up</CardTitle>
      <p className="text-sm leading-relaxed">One file holding everything Kinfold remembers. Your agents keep working while it is written.</p>
      <p className="mt-2 text-sm leading-relaxed text-muted">If this memory is encrypted, the file is too, and restoring it needs your recovery code. Keep that code somewhere other than this computer; kinfold key show-recovery prints it.</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button asChild variant="primary"><a href="/backup" download><Download aria-hidden="true" className="h-4 w-4" />Download a backup</a></Button>
        <span className="text-sm text-muted">{lastBackupAt === null ? 'No backup made yet.' : lastBackupAt !== undefined ? `Last backup ${ago(lastBackupAt)}.` : ''}</span>
      </div>
    </Card>
  )
}

function Restore({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [flow, setFlow] = useState<RestoreFlow>({ stage: 'idle' })
  const [confirmed, setConfirmed] = useState(false)
  const [hasCode, setHasCode] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const code = useRef<HTMLInputElement>(null)
  const upload = useMutation({ mutationFn: async (picked: File) => uploadedRestore(await uploadFile('/restore/upload', picked)), onSuccess: setFlow })
  const restore = useMutation({
    mutationFn: async () => {
      const body = restoreBody(flow, code.current?.value ?? '', confirmed)
      // From here the code lives only in this request.
      if (code.current !== null) code.current.value = ''
      setHasCode(false)
      setStep(stepText('check'))
      await api('POST', '/restore', body)
      return follow(setStep, false)
    },
    onSettled: () => setConfirmed(false),
    onSuccess: () => {
      setFlow({ stage: 'idle' })
      setStep(null)
      onDone()
    },
  })
  const ready = canRestore(flow, hasCode ? 'x' : '', confirmed)
  return (
    <Card aria-label="Restore">
      <CardTitle>Restore</CardTitle>
      <p className="text-sm leading-relaxed">Replace the memory on this computer with a backup file.</p>
      <p className="mt-2 text-sm leading-relaxed text-muted">The memory in use now is kept beside the restored one, so you can switch back. Saved API keys are not part of a backup.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="restore-file" className="block text-sm font-medium">Backup file (.kfb)</label>
          <input id="restore-file" type="file" accept=".kfb" className="text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setFlow({ stage: 'idle' }) }} />
        </div>
        <Button size="sm" disabled={file === null || upload.isPending} onClick={() => file !== null && upload.mutate(file)}>{upload.isPending ? 'Reading…' : 'Read the backup'}</Button>
      </div>
      {flow.stage === 'uploaded' ? (
        <div className="mt-4 space-y-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-surface-2 p-3 text-sm">
            {describeManifest(flow.manifest).map(([label, value]) => <div key={label} className="contents"><dt className="text-muted">{label}</dt><dd>{value}</dd></div>)}
          </dl>
          {flow.manifest.encrypted ? (
            <div className="space-y-1">
              <label htmlFor="restore-code" className="block text-sm font-medium">Recovery code of this backup</label>
              <Input id="restore-code" ref={code} className="font-mono [-webkit-text-security:disc]" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXXX-XXXXX-…" onChange={(event) => setHasCode(event.target.value.trim() !== '')} />
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Replace the memory on this computer with this backup</label>
          <Button variant="danger" size="sm" disabled={!ready || restore.isPending} onClick={() => restore.mutate()}>Restore</Button>
        </div>
      ) : null}
      {step !== null && restore.isPending ? <Notice className="mt-3">{step}</Notice> : null}
      {restore.isSuccess ? (
        <Notice tone="good" className="mt-3">
          The backup is restored.
          {restore.data.lines.length > 0 ? <ul className="mt-1 list-disc pl-5 text-muted">{restore.data.lines.map((line) => <li key={line}>{line}</li>)}</ul> : null}
        </Notice>
      ) : null}
      {upload.isError || restore.isError ? <Notice tone="bad" className="mt-3">{errorText(upload.error ?? restore.error)}</Notice> : null}
    </Card>
  )
}

function SwitchBack({ replacedAt, onDone }: { replacedAt: number; onDone: () => void }) {
  const [confirmed, setConfirmed] = useState(false)
  const [step, setStep] = useState<string | null>(null)
  const undo = useMutation({
    mutationFn: async () => {
      setStep(stepText('check', true))
      await api('POST', '/restore/undo')
      return follow(setStep, true)
    },
    onSettled: () => setConfirmed(false),
    onSuccess: onDone,
  })
  return (
    <Card aria-label="Switch back">
      <CardTitle>Switch back</CardTitle>
      <p className="text-sm leading-relaxed">Go back to the memory a restore replaced on {dateOnly(replacedAt)}. The memory in use now is kept in its place, so you can switch again. No recovery code is needed.</p>
      <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Replace the memory in use with the kept one</label>
      <Button variant="danger" size="sm" className="mt-3" disabled={!confirmed || undo.isPending} onClick={() => undo.mutate()}>Switch back</Button>
      {step !== null && undo.isPending ? <Notice className="mt-3">{step}</Notice> : null}
      {undo.isSuccess ? <Notice tone="good" className="mt-3">Switched back.</Notice> : null}
      {undo.isError ? <Notice tone="bad" className="mt-3">{errorText(undo.error)}</Notice> : null}
    </Card>
  )
}

export function BackupPage() {
  const client = useQueryClient()
  const { hubOnly, hub } = useHubOnly()
  const status = useQuery({ queryKey: ['/restore/status'], queryFn: () => get<RestoreStatus>('/restore/status'), enabled: !hubOnly })
  const refresh = (): void => void client.invalidateQueries()
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader title="Backup">Keep a copy of your memory somewhere safe, and bring it back when you need it.</PageHeader>
      {hubOnly ? <Notice>This device uses memory kept on {hub}. Back it up and restore it there, in that computer's dashboard.</Notice> : (
        <>
          {status.data?.state === 'running' ? <Notice>A restore is running. This page shows how it ends.</Notice> : null}
          <BackUp lastBackupAt={status.data?.lastBackupAt} />
          <Restore onDone={refresh} />
          {status.data?.kept !== null && status.data?.kept !== undefined ? <SwitchBack replacedAt={status.data.kept.replacedAt} onDone={refresh} /> : null}
        </>
      )}
    </div>
  )
}

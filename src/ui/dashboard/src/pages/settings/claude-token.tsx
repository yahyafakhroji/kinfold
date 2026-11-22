// The claude-cli observer's long-lived token. The page sends a pasted token
// to the daemon, which keeps it in the key store; the token never comes back
// to the page, which only learns whether one is saved.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Notice } from '../../components/ui/notice'
import { api, errorText } from '../../lib/api'
import { Field } from './section'

export type ClaudeAuth = 'token' | 'login' | 'unknown'

export interface TokenView {
  effective: ({ host: string; settings: { provider: string; enabled: boolean } } | { host: string; error: string })[]
  claudeAuth?: ClaudeAuth
}

/** An agent summarises through claude-cli, and the daemon is new enough to keep a token. */
export function showsClaudeToken(view: TokenView): boolean {
  if (view.claudeAuth === undefined) return false
  return view.effective.some((entry) => 'settings' in entry && entry.settings.enabled && entry.settings.provider === 'claude-cli')
}

export function claudeAuthText(auth: ClaudeAuth): string {
  if (auth === 'token') return 'Summaries sign in with a long-lived token, kept in the key store. When it expires, run claude setup-token again and paste the new one here.'
  if (auth === 'login') return "Summaries sign in with the claude CLI's own login. If that login keeps expiring, run claude setup-token in a terminal and paste the token here."
  return 'The key store could not be asked whether a token is saved.'
}

export function ClaudeToken({ auth, disabled }: { auth: ClaudeAuth; disabled: boolean }) {
  const id = useId()
  const client = useQueryClient()
  const [token, setToken] = useState('')
  const refresh = (): void => void client.invalidateQueries({ queryKey: ['/observer/settings'] })
  const save = useMutation({
    mutationFn: () => api('PUT', '/observer/claude-token', { token }),
    onSuccess: () => {
      setToken('')
      refresh()
    },
  })
  const remove = useMutation({ mutationFn: () => api('DELETE', '/observer/claude-token'), onSuccess: refresh })
  return (
    <form
      className="mb-4 space-y-2 rounded-lg border border-border p-3"
      aria-label="Claude Code sign-in for summaries"
      onSubmit={(event) => {
        event.preventDefault()
        if (token.trim() !== '') save.mutate()
      }}
    >
      <p className="text-sm">{claudeAuthText(auth)}</p>
      <Field label={auth === 'token' ? 'Replace the token' : 'Long-lived token'} htmlFor={id} help="From claude setup-token. It is not shown again.">
        <Input id={id} type="password" autoComplete="off" spellCheck={false} value={token} disabled={disabled} onChange={(event) => setToken(event.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={disabled || token.trim() === '' || save.isPending}>Save token</Button>
        {auth === 'token' ? <Button variant="dangerQuiet" disabled={disabled || remove.isPending} onClick={() => remove.mutate()}>Remove token</Button> : null}
      </div>
      {save.isError ? <Notice tone="bad">{errorText(save.error)}</Notice> : null}
      {remove.isError ? <Notice tone="bad">{errorText(remove.error)}</Notice> : null}
    </form>
  )
}

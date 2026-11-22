import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '../../lib/cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

export function Switch({ checked, onCheckedChange, disabled, ...rest }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn('relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50', checked ? 'bg-accent' : 'bg-border')}
      {...rest}
    >
      <SwitchPrimitive.Thumb className={cn('block h-4 w-4 rounded-full bg-surface shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </SwitchPrimitive.Root>
  )
}

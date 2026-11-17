// Light by default, dark when the system is, and either one when the reader
// picks it. The choice is a per-browser convenience in localStorage; a
// private window or blocked storage simply follows the system.

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'kinfold-theme'

export function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

const systemDark = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches

export function applyTheme(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'system' && systemDark())
  document.documentElement.classList.toggle('dark', dark)
}

export function saveTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    // Storage is off in this browser: the choice lasts for this page only.
  }
  applyTheme(choice)
}

/** Keeps "system" in step when the system switches while the page is open. */
export function followSystem(): () => void {
  if (typeof matchMedia !== 'function') return () => {}
  const media = matchMedia('(prefers-color-scheme: dark)')
  const change = (): void => {
    if (readTheme() === 'system') applyTheme('system')
  }
  media.addEventListener('change', change)
  return () => media.removeEventListener('change', change)
}

// What of a prompt recall may search on. Agents wrap parts of what the user
// sends: Claude Code marks a paste with `<pasted_content id="bb24">` and adds
// system reminders and slash-command blocks. Searched as typed, the tag names
// and ids became query terms ("pasted", "content", "bb24") and a long paste
// pushed the user's own words out of the 2,000 characters the hook sends. Here
// wrapper tags and ids go, agent-added blocks go whole, and a paste is kept
// apart from the user's own words so terms can rank those first. Pure string
// work, safe for the hook's hot path: it never logs or keeps the text.

/** Blocks the agent adds around or beside the user's words: dropped with what they hold. */
const DROPPED_BLOCKS = ['system-reminder', 'command-name', 'command-message', 'local-command-stdout', 'local-command-stderr', 'user-prompt-submit-hook']
/** Tags whose content is the user's own words: the tags go, the words stay. */
const UNWRAPPED_TAGS = ['command-args']

const PASTE_OPEN = /<pasted_content\b[^>]*>/i
const PASTE_CLOSE = /<\/pasted_content\b[^>]*>/i
const DROPPED = new RegExp(`<(${DROPPED_BLOCKS.join('|')})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi')
const UNWRAPPED = new RegExp(`</?(?:${UNWRAPPED_TAGS.join('|')})\\b[^>]*>`, 'gi')

export interface PromptParts {
  /** The user's own words, wrappers removed, spaces collapsed. */
  own: string
  /** Each paste's content, in order. */
  pasted: string[]
}

const tidy = (text: string): string => text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()

/** Splits on paste tags; a paste whose closing tag was cut off runs to the end. */
export function splitPrompt(text: string): PromptParts {
  const own: string[] = []
  const pasted: string[] = []
  let rest = text.replace(DROPPED, ' ').replace(UNWRAPPED, ' ')
  for (;;) {
    const open = PASTE_OPEN.exec(rest)
    if (open === null) {
      own.push(rest)
      break
    }
    own.push(rest.slice(0, open.index))
    const after = rest.slice(open.index + open[0].length)
    const close = PASTE_CLOSE.exec(after)
    pasted.push(close === null ? after : after.slice(0, close.index))
    if (close === null) break
    rest = after.slice(close.index + close[0].length)
  }
  return { own: tidy(own.join(' ')).replace(/\n/g, ' ').replace(/ {2,}/g, ' '), pasted: pasted.map(tidy).filter((part) => part !== '') }
}

/** Own words, then each paste, with no tag or id: what the embedder is given. */
export function searchablePrompt(text: string): string {
  const { own, pasted } = splitPrompt(text)
  return [own, ...pasted].filter((part) => part !== '').join('\n')
}

/**
 * The form the hook sends: own words first, then each paste in a bare tag
 * (no id), so the daemon can still tell them apart and a cut at the request's
 * size limit drops paste before it drops the user's words. A prompt with no
 * wrapper is returned as typed.
 */
export function promptForRecall(text: string): string {
  const { own, pasted } = splitPrompt(text)
  if (pasted.length === 0 && own === tidy(text)) return text
  return [own, ...pasted.map((part) => `<pasted_content>\n${part}\n</pasted_content>`)].filter((part) => part !== '').join('\n')
}

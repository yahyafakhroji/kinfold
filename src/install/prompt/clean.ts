// The one filter between a name that came from outside (a host, a model, a
// file, a device) and the terminal. No imports, so the bar and the prompts both
// use this copy and a change to it reaches every line they draw.

/** The text without control and format characters: no terminal escape, and no bidirectional mark that reorders what is shown. */
export const clean = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '')

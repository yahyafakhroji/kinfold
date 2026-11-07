// True when this process is a compiled program rather than a checkout run
// through bun. It lives outside the installer so the hook can tell which mode
// it runs in without loading an installer module.

export function isCompiledProgram(main: string = Bun.main): boolean {
  return main.startsWith('/$bunfs/') || main.startsWith('B:\\~BUN\\')
}

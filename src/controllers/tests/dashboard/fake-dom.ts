// A minimal fake document for testing the dashboard's DOM code in bun test:
// elements, text nodes, attributes, listeners. Setting innerHTML, outerHTML
// or calling insertAdjacentHTML throws, so any use of an HTML parser fails
// the test that hit it. Tests only.

export class FakeNode {
  readonly nodeType: number
  readonly childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  text: string

  constructor(nodeType: number, text: string = '') {
    this.nodeType = nodeType
    this.text = text
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  removeChild(child: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(child)
    if (at >= 0) this.childNodes.splice(at, 1)
    child.parentNode = null
    return child
  }

  get textContent(): string {
    return this.nodeType === 3 ? this.text : this.childNodes.map((child) => child.textContent).join('')
  }
}

export class FakeElement extends FakeNode {
  readonly tagName: string
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, ((event: unknown) => void)[]>()
  className = ''

  constructor(tag: string) {
    super(1)
    this.tagName = tag.toUpperCase()
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value))
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  querySelector(): null {
    return null
  }

  set innerHTML(_value: string) {
    throw new Error('innerHTML was used')
  }

  set outerHTML(_value: string) {
    throw new Error('outerHTML was used')
  }

  insertAdjacentHTML(): never {
    throw new Error('insertAdjacentHTML was used')
  }
}

export interface FakeDocument {
  createElement(tag: string): FakeElement
  createTextNode(text: string): FakeNode
  getElementById(id: string): FakeElement | null
}

export function fakeDocument(byId: Record<string, FakeElement> = {}): FakeDocument {
  return {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeNode(3, String(text)),
    getElementById: (id) => byId[id] ?? null,
  }
}

/** Every element in the tree, depth first. */
export function elements(root: FakeNode): FakeElement[] {
  const own = root instanceof FakeElement ? [root] : []
  return [...own, ...root.childNodes.flatMap((child) => elements(child))]
}

/** Every text node in the tree. */
export function textNodes(root: FakeNode): FakeNode[] {
  if (root.nodeType === 3) return [root]
  return root.childNodes.flatMap((child) => textNodes(child))
}

// Builds DOM nodes from data without ever parsing HTML. Stored titles,
// narratives and facts are untrusted text written by a model from tool
// output, so every value becomes a text node (createTextNode) or an
// attribute set through setAttribute; no HTML-parsing API is used anywhere.
// Event handlers are only ever functions, and an href must be a local
// path or hash, so a value cannot become a script URL either.

/** @typedef {string | number | Node | null | undefined | false | Child[]} Child */
/** @typedef {Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>} Props */

const LOCAL_HREF = /^[#/]/

/**
 * @param {Element} element
 * @param {Props} props
 */
function setProps(element, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on')) {
      if (typeof value === 'function') element.addEventListener(key.slice(2), value)
      continue
    }
    if (typeof value === 'function') continue
    if (key === 'href' && !LOCAL_HREF.test(String(value))) continue
    if (key === 'class') element.className = String(value)
    else element.setAttribute(key, value === true ? '' : String(value))
  }
}

/**
 * @param {Node} parent
 * @param {Child[]} children
 */
export function appendAll(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) appendAll(parent, child)
    else parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

/**
 * h('a', { href: '#memory', class: 'link' }, 'text', otherNode)
 * @param {string} tag
 * @param {Props} [props]
 * @param {...Child} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag)
  setProps(element, props)
  appendAll(element, children)
  return element
}

/**
 * Empties `parent`, then appends the children.
 * @param {Element} parent
 * @param {...Child} children
 */
export function replaceContent(parent, ...children) {
  while (parent.firstChild !== null) parent.removeChild(parent.firstChild)
  appendAll(parent, children)
}

/**
 * A small status line; `tone` is ok, error or quiet.
 * @param {string} message
 * @param {'ok' | 'error' | 'quiet'} [tone]
 */
export function notice(message, tone = 'quiet') {
  return h('p', { class: `notice notice-${tone}`, role: tone === 'error' ? 'alert' : 'status' }, message)
}

/**
 * A table inside its own scroll container, so a wide table never scrolls the page.
 * @param {string} caption
 * @param {string[]} head
 * @param {Child[][]} rows
 * @param {string} [empty]
 */
export function table(caption, head, rows, empty = 'Nothing here yet.') {
  if (rows.length === 0) return h('div', { class: 'table-wrap' }, h('p', { class: 'empty' }, empty))
  return h('div', { class: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': caption },
    h('table', {},
      h('caption', { class: 'visually-hidden' }, caption),
      h('thead', {}, h('tr', {}, head.map((label) => h('th', { scope: 'col' }, label)))),
      h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((cell) => h('td', {}, cell)))))))
}

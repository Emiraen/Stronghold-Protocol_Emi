// First-frame DOM fixture: run real Preact hooks instead of calling hook components as plain functions.
import { h, render, options } from '../../public/vendor/preact.module.js';

export function renderFirstFrame(Component, props) {
  const previousDocument = globalThis.document;
  const previousDiffed = options.diffed;
  let tree;
  const doc = {
    createElement: name => node(name),
    createElementNS: (_ns, name) => node(name),
    createTextNode: value => ({ nodeType: 3, data: String(value), parentNode: null }),
  };
  function node(name) {
    return {
      nodeType: 1, localName: name, namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc,
      childNodes: [], parentNode: null, attributes: [], style: { setProperty() {} },
      get firstChild() { return this.childNodes[0] || null; },
      get nextSibling() { const xs = this.parentNode?.childNodes || []; return xs[xs.indexOf(this) + 1] || null; },
      appendChild(child) { return this.insertBefore(child, null); },
      insertBefore(child, before) {
        child.parentNode?.removeChild(child);
        const at = before ? this.childNodes.indexOf(before) : -1;
        this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
        child.parentNode = this; return child;
      },
      removeChild(child) { const at = this.childNodes.indexOf(child); if (at >= 0) this.childNodes.splice(at, 1); child.parentNode = null; return child; },
      setAttribute(name, value) { this[name] = String(value); },
      setAttributeNS(_ns, name, value) { this.setAttribute(name, value); },
      removeAttribute(name) { delete this[name]; },
      removeAttributeNS(_ns, name) { this.removeAttribute(name); },
      addEventListener() {}, removeEventListener() {},
    };
  }
  const root = node('div');
  globalThis.document = doc;
  options.diffed = vnode => {
    previousDiffed?.(vnode);
    if (vnode.type === 'span' && vnode.props?.['data-testid'] === 'miss-tag') tree = vnode;
  };
  try { render(h(Component, props), root); return tree; }
  finally { render(null, root); options.diffed = previousDiffed; if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; }
}

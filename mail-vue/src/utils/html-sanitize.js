const BLOCKED_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'formaction']);

export function sanitizeHtml(html = '') {
  const template = document.createElement('template');
  template.innerHTML = String(html);

  sanitizeNode(template.content);

  return template.innerHTML;
}

export function sanitizeStyleAttribute(style = '') {
  return String(style)
      .replace(/expression\s*\([^)]*\)/gi, '')
      .replace(/url\s*\(\s*(['"]?)\s*javascript:[^)]+\)/gi, '');
}

function sanitizeNode(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const nodes = [];

  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }

  nodes.forEach((node) => {
    const tagName = node.tagName?.toLowerCase();

    if (BLOCKED_TAGS.has(tagName)) {
      node.remove();
      return;
    }

    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();

      if (name.startsWith('on') || name === 'srcdoc') {
        node.removeAttribute(attr.name);
        return;
      }

      if (URL_ATTRS.has(name) && isUnsafeUrl(value)) {
        node.removeAttribute(attr.name);
        return;
      }

      if (name === 'style') {
        const safeStyle = sanitizeStyleAttribute(value);
        if (safeStyle) {
          node.setAttribute(attr.name, safeStyle);
        } else {
          node.removeAttribute(attr.name);
        }
      }
    });
  });
}

function isUnsafeUrl(value) {
  const normalized = value.replace(/[\u0000-\u001F\u007F\s]+/g, '').toLowerCase();
  return normalized.startsWith('javascript:') || normalized.startsWith('data:text/html');
}

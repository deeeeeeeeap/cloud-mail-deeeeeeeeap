import { parseHTML } from 'linkedom';

const BLOCKED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form']);
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'formaction', 'action']);
const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,/i;

export function escapeHtml(value = '') {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function jsStringLiteral(value = '') {
	return JSON.stringify(String(value)).replace(/<\//g, '<\\/');
}

export function sanitizeStyleAttribute(style = '') {
	return String(style)
		.split(';')
		.map(item => item.trim())
		.filter(Boolean)
		.filter(item => !/<\/?style/i.test(item))
		.filter(item => !/@import/i.test(item))
		.filter(item => !/expression\s*\(/i.test(item))
		.filter(item => !/url\s*\(/i.test(item))
		.join('; ');
}

export function sanitizeEmailHtml(html = '') {
	const { document } = parseHTML(String(html));

	document.querySelectorAll([...BLOCKED_TAGS].join(',')).forEach(node => node.remove());
	document.querySelectorAll('*').forEach(node => {
		Array.from(node.attributes).forEach(attr => {
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

	return document.toString();
}

function isUnsafeUrl(value) {
	const normalized = value.replace(/[\u0000-\u001F\u007F\s]+/g, '').toLowerCase();
	if (normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')) {
		return true;
	}
	if (normalized.startsWith('data:') && !SAFE_DATA_IMAGE.test(value)) {
		return true;
	}
	return false;
}

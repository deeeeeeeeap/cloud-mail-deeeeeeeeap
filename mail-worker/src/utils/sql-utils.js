// D1 限制每条语句最多 100 个绑定参数；IN(...) 列表统一按 90 分块，
// 给同语句中的其它绑定留出余量。
export const IN_CHUNK_SIZE = 90;

export function chunkArray(list, size = IN_CHUNK_SIZE) {
	const items = Array.isArray(list) ? list : Array.from(list || []);
	const chunks = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

// D1 限制 LIKE/GLOB 模式最长 50 字节，超限直接抛 SQLITE 错误；按 UTF-8 字节截断避免 500
export const LIKE_PATTERN_MAX_BYTES = 50;

const textEncoder = new TextEncoder();

export function utf8ByteLength(value) {
	return textEncoder.encode(String(value ?? '')).length;
}

export function truncateByBytes(value, maxBytes) {
	const text = String(value ?? '');
	if (maxBytes <= 0) {
		return '';
	}
	if (textEncoder.encode(text).length <= maxBytes) {
		return text;
	}
	let result = '';
	let used = 0;
	for (const ch of text) {
		const size = textEncoder.encode(ch).length;
		if (used + size > maxBytes) {
			break;
		}
		result += ch;
		used += size;
	}
	return result;
}

export function truncateLikeTerm(term, wildcardBytes = 2) {
	return truncateByBytes(term, LIKE_PATTERN_MAX_BYTES - wildcardBytes);
}

export async function runBatch(c, statements) {
	if (!statements || statements.length === 0) {
		return [];
	}

	if (c.env.db.batch) {
		return await c.env.db.batch(statements);
	}

	const results = [];
	for (const statement of statements) {
		results.push(await statement.run());
	}
	return results;
}

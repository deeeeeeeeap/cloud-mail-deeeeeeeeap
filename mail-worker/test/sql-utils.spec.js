import { describe, expect, it } from 'vitest';
import { chunkArray, runBatch, IN_CHUNK_SIZE, truncateLikeTerm, truncateByBytes, utf8ByteLength, LIKE_PATTERN_MAX_BYTES } from '../src/utils/sql-utils';

describe('sql utils', () => {
	it('chunks lists to stay under the D1 bind limit', () => {
		expect(chunkArray([])).toEqual([]);
		expect(chunkArray(null)).toEqual([]);
		expect(chunkArray([1, 2])).toEqual([[1, 2]]);

		const chunks = chunkArray(Array.from({ length: IN_CHUNK_SIZE * 2 + 1 }, (_, i) => i));
		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toHaveLength(IN_CHUNK_SIZE);
		expect(chunks[1]).toHaveLength(IN_CHUNK_SIZE);
		expect(chunks[2]).toHaveLength(1);
	});

	it('uses db.batch when available', async () => {
		const batched = [];
		const c = {
			env: {
				db: {
					async batch(items) {
						batched.push(...items);
						return items.map(() => ({ success: true }));
					}
				}
			}
		};

		const results = await runBatch(c, [{}, {}]);

		expect(batched).toHaveLength(2);
		expect(results).toHaveLength(2);
	});

	it('falls back to sequential runs when batch is unavailable', async () => {
		const ran = [];
		const statements = [1, 2].map(id => ({
			async run() {
				ran.push(id);
				return { id };
			}
		}));

		const results = await runBatch({ env: { db: {} } }, statements);

		expect(ran).toEqual([1, 2]);
		expect(results).toHaveLength(2);
	});

	it('skips empty statement lists', async () => {
		expect(await runBatch({ env: { db: {} } }, [])).toEqual([]);
	});

	it('truncates LIKE terms so wrapped patterns fit the D1 50-byte limit', () => {
		const longAscii = 'a'.repeat(80);
		const truncated = truncateLikeTerm(longAscii);
		expect(utf8ByteLength(`%${truncated}%`)).toBeLessThanOrEqual(LIKE_PATTERN_MAX_BYTES);
		expect(truncated).toBe('a'.repeat(48));

		const short = 'hello';
		expect(truncateLikeTerm(short)).toBe(short);
	});

	it('truncates multi-byte characters without splitting them', () => {
		const chinese = '验证码'.repeat(30);
		const truncated = truncateByBytes(chinese, 50);
		expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(50);
		expect(truncated.length % 1).toBe(0);
		expect([...truncated].every(ch => '验证码'.includes(ch))).toBe(true);
		expect(utf8ByteLength(truncated)).toBe(48);
	});
});

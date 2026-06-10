import { describe, expect, it } from 'vitest';
import emailSearchService from '../src/service/email-search-service';
import { dbInit } from '../src/init/init';

function createDbRecorder() {
	const statements = [];
	return {
		statements,
		c: {
			env: {
				db: {
					prepare(sql) {
						const statement = {
							sql,
							bindings: [],
							bind(...args) {
								this.bindings = args;
								return this;
							},
							async run() {
								return { success: true };
							}
						};
						statements.push(statement);
						return statement;
					}
				}
			}
		}
	};
}

describe('email search service', () => {
	it('limits email body text while syncing the derived search index', async () => {
		const recorder = createDbRecorder();

		await emailSearchService.syncEmailIds(recorder.c, [10, 11]);

		const insertSearch = recorder.statements.find(statement => statement.sql.includes('INSERT OR REPLACE INTO email_search'));

		expect(insertSearch.sql).toContain("SUBSTR(COALESCE(e.text, ''), 1, 4000)");
		expect(insertSearch.bindings).toEqual([10, 11]);
	});

	it('limits email body text when initializing the derived search index', async () => {
		const recorder = createDbRecorder();

		await dbInit.v3_0DB(recorder.c);

		const insertSearch = recorder.statements.find(statement => statement.sql.includes('INSERT OR REPLACE INTO email_search'));

		expect(insertSearch.sql).toContain("SUBSTR(COALESCE(e.text, ''), 1, 4000)");
	});

	it('deduplicates ids before syncing', async () => {
		const recorder = createDbRecorder();

		await emailSearchService.syncEmailIds(recorder.c, [10, 10, 11]);

		const insertSearch = recorder.statements.find(statement => statement.sql.includes('INSERT OR REPLACE INTO email_search'));

		expect(insertSearch.bindings).toEqual([10, 11]);
	});

	it('chunks large id lists below the D1 bind limit and batches them', async () => {
		const statements = [];
		const batched = [];
		const c = {
			env: {
				db: {
					prepare(sql) {
						const statement = {
							sql,
							bindings: [],
							bind(...args) {
								this.bindings = args;
								return this;
							},
							async run() {
								return { success: true };
							}
						};
						statements.push(statement);
						return statement;
					},
					async batch(items) {
						batched.push(...items);
						return items.map(() => ({ success: true }));
					}
				}
			}
		};

		const ids = Array.from({ length: 181 }, (_, i) => i + 1);

		await emailSearchService.syncEmailIds(c, ids);

		expect(batched).toHaveLength(3);
		expect(Math.max(...batched.map(statement => statement.bindings.length))).toBeLessThanOrEqual(90);
		expect(batched.flatMap(statement => statement.bindings)).toEqual(ids);

		batched.length = 0;
		statements.length = 0;

		await emailSearchService.removeEmailIds(c, ids);

		expect(batched).toHaveLength(3);
		expect(Math.max(...batched.map(statement => statement.bindings.length))).toBeLessThanOrEqual(90);
		expect(batched.flatMap(statement => statement.bindings)).toEqual(ids);
	});
});

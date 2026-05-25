import { describe, expect, it, vi } from 'vitest';

import codeService, { CODE_STALE_MINUTES } from '../src/service/code-service';
import emailSearchService from '../src/service/email-search-service';

function createDbRecorder(resultsList = []) {
	const statements = [];
	const queue = Array.isArray(resultsList[0]) ? [...resultsList] : [resultsList];
	return {
		statements,
		db: {
			prepare(sql) {
				const statement = {
					sql,
					bindings: [],
					bind(...args) {
						this.bindings = args;
						return this;
					},
					async all() {
						return { results: queue.length > 0 ? queue.shift() : [] };
					},
					async run() {
						return { success: true };
					}
				};
				statements.push(statement);
				return statement;
			}
		}
	};
}

describe('code service', () => {
	it('lists current user verification codes with bound filters and capped page size', async () => {
		const recorder = createDbRecorder([[], []]);
		const c = { env: { db: recorder.db } };

		await codeService.list(c, {
			query: "123456' OR 1=1 --",
			stale: 'fresh',
			size: 500,
			emailId: 0,
			timeSort: 0
		}, 42);

		const statement = recorder.statements.find(item => item.sql.includes('e.code AS code'));
		expect(statement.sql).toContain('e.user_id = ?');
		expect(statement.sql).toContain('LOWER(e.code) LIKE ?');
		expect(statement.sql).toContain("datetime(e.create_time) >= datetime('now', '-15 minutes')");
		expect(statement.sql).not.toContain("123456' OR 1=1 --");
		expect(statement.bindings).toContain(42);
		expect(statement.bindings).toContain("%123456' or 1=1 --%");
		expect(statement.bindings.at(-1)).toBe(51);
	});

	it('lists all verification codes without a user filter and returns user email', async () => {
		const recorder = createDbRecorder([[], [{ emailId: 1, code: '888888', createTime: new Date().toISOString(), userEmail: 'u@example.com' }]]);
		const c = { env: { db: recorder.db } };

		const result = await codeService.allList(c, { stale: 'all', size: 10, emailId: 0, timeSort: 1 });

		const statement = recorder.statements.find(item => item.sql.includes('e.code AS code'));
		expect(statement.sql).toContain('LEFT JOIN user u ON u.user_id = e.user_id');
		expect(statement.sql).toContain('u.email AS userEmail');
		expect(statement.sql).not.toContain('e.user_id = ?');
		expect(statement.sql).not.toContain("datetime(e.create_time) >=");
		expect(result.list[0].userEmail).toBe('u@example.com');
		expect(result.list[0].isStale).toBe(false);
		expect(result.list[0].expiresInMinutes).toBe(CODE_STALE_MINUTES);
		expect(result.hasMore).toBe(false);
	});

	it('backfills recent local codes before listing without calling AI', async () => {
		const recorder = createDbRecorder([
			[{ emailId: 772, subject: 'Your Notion signup code', text: '922951\n', html: '' }],
			[{ emailId: 772, code: '922951', createTime: new Date().toISOString() }]
		]);
		const c = { env: { db: recorder.db } };
		const syncSpy = vi.spyOn(emailSearchService, 'syncEmailIds').mockResolvedValue();

		await codeService.list(c, { stale: 'fresh', size: 10, emailId: 0, timeSort: 0 }, 1);

		const backfillStatement = recorder.statements.find(item => item.sql.includes('e.code ='));
		expect(backfillStatement.sql).toContain(`datetime(e.create_time) >= datetime('now', '-${CODE_STALE_MINUTES} minutes')`);
		const updateStatement = recorder.statements.find(item => item.sql.includes('UPDATE email SET code'));
		expect(updateStatement.bindings).toEqual(['922951', 772]);
		expect(syncSpy).toHaveBeenCalledWith(c, [772]);
		syncSpy.mockRestore();
	});
});

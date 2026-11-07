import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import analysisDao from '../src/dao/analysis-dao';

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
							async all() {
								return { results: [] };
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

describe('analysis dao day counts', () => {
	it('uses sargable bare-column ranges instead of DATE()-wrapped predicates', async () => {
		const recorder = createDbRecorder();

		await analysisDao.receiveDayCount(recorder.c, 8);

		const statement = recorder.statements[0];
		expect(statement.sql).toContain(`create_time >= DATETIME(DATE('now', '-15 days', ?1), ?2)`);
		expect(statement.sql).toContain(`create_time < DATETIME(DATE('now', ?1), ?2)`);
		expect(statement.sql).not.toMatch(/WHERE[\s\S]*DATE\(create_time[\s\S]*BETWEEN/);
		expect(statement.bindings).toEqual(['+8 hours', '-8 hours', 0]);
	});

	it('emits valid signed modifiers for negative timezone offsets', async () => {
		const recorder = createDbRecorder();

		await analysisDao.userDayCount(recorder.c, -5.5);

		const statement = recorder.statements[0];
		expect(statement.bindings).toEqual(['-5.5 hours', '+5.5 hours']);
	});

	it('distinguishes send and receive email types', async () => {
		const recorder = createDbRecorder();

		await analysisDao.sendDayCount(recorder.c, 0);

		const statement = recorder.statements[0];
		expect(statement.sql).toContain('type = ?3');
		expect(statement.bindings).toEqual(['+0 hours', '+0 hours', 1]);
	});
});

describe('analysis dao day send total', () => {
	beforeAll(async () => {
		const response = await SELF.fetch('http://example.com/api/init', {
			method: 'POST',
			headers: { 'X-Cloud-Mail-Init-Secret': 'your-jwt-secret' }
		});
		expect(response.status).toBe(200);
	});

	it('counts today\'s finished outbound recipients including cc and bcc from D1', async () => {
		const insert = (type, status, recipient, cc, bcc, createTime = "datetime('now')") => env.db.prepare(`
			INSERT INTO email (account_id, user_id, type, status, recipient, cc, bcc, create_time)
			VALUES (1, 1, ?, ?, ?, ?, ?, ${createTime})
		`).bind(type, status, recipient, cc, bcc);
		const to = count => JSON.stringify(Array.from({ length: count }, (_, i) => ({ address: `r${i}@example.com`, name: '' })));

		await env.db.batch([
			env.db.prepare('DELETE FROM email'),
			insert(1, 2, to(2), to(1), to(1)),
			insert(1, 1, to(1), '[]', ''),
			insert(1, 7, to(1), '[]', '[]'),
			insert(1, 1, 'legacy@example.com', '[]', '[]'),
			insert(1, 6, to(3), '[]', '[]'),
			insert(1, 8, to(3), '[]', '[]'),
			insert(1, 2, to(5), '[]', '[]', "datetime('now', '-1 day')"),
			insert(0, 0, to(2), '[]', '[]')
		]);

		const captured = [];
		const c = {
			env: {
				db: {
					prepare(sql) {
						const statement = env.db.prepare(sql);
						return {
							bind(...args) {
								captured.push({ sql, args });
								return statement.bind(...args);
							}
						};
					}
				}
			}
		};

		expect(await analysisDao.daySendTotal(c)).toBe(7);

		const { sql, args } = captured[0];
		const { results: plan } = await env.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all();
		expect(plan.map(row => row.detail).join(' | ')).toContain('idx_email_type_create_time');
	});
});

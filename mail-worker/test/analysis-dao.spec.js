import { describe, expect, it } from 'vitest';
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

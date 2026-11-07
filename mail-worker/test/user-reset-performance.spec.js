import { afterEach, describe, expect, it, vi } from 'vitest';
import roleService from '../src/service/role-service';
import userService from '../src/service/user-service';

describe('daily send count reset query budget', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('updates only non-zero counters for roles with a daily send quota', async () => {
		const statements = [];
		const db = {
			prepare(sql) {
				const statement = {
					sql,
					bindings: [],
					bind(...bindings) {
						this.bindings = bindings;
						return this;
					},
					async run() {
						return { success: true, meta: { changes: 1 } };
					}
				};
				statements.push(statement);
				return statement;
			}
		};
		vi.spyOn(roleService, 'selectByIdsAndSendType')
			.mockResolvedValue([{ roleId: 2 }, { roleId: 5 }]);

		await userService.resetDaySendCount({ env: { db } });

		expect(roleService.selectByIdsAndSendType)
			.toHaveBeenCalledWith(expect.anything(), 'email:send', 'day');
		expect(statements).toHaveLength(1);
		const normalizedSql = statements[0].sql.replace(/\s+/g, ' ').toLowerCase();
		expect(normalizedSql).toMatch(/where .*type.* in \([^)]*\).* and .*send_count.*(?:<>|!=)/);
		expect(statements[0].bindings).toEqual([0, 2, 5, 0]);
	});

	it('skips the update when no role has a daily send quota', async () => {
		const prepare = vi.fn();
		vi.spyOn(roleService, 'selectByIdsAndSendType').mockResolvedValue([]);

		await userService.resetDaySendCount({ env: { db: { prepare } } });

		expect(prepare).not.toHaveBeenCalled();
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/init/init', () => ({
	dbInit: {
		v3_0DB: vi.fn(),
		runOptionalSqlList: vi.fn()
	}
}));

vi.mock('../src/service/email-search-service', () => ({
	default: {
		syncEmailIds: vi.fn()
	}
}));

const { dbInit } = await import('../src/init/init');
const { default: emailSearchService } = await import('../src/service/email-search-service');
const { default: maintenanceService } = await import('../src/service/maintenance-service');

describe('maintenance service', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.restoreAllMocks();
	});

	it('reports missing bindings without exposing secrets', async () => {
		const result = await maintenanceService.health({ env: {} });

		expect(result.ok).toBe(false);
		expect(result.checks.find(item => item.key === 'd1').ok).toBe(false);
		expect(JSON.stringify(result)).not.toMatch(/token|secret|password/i);
	});

	it('rejects repair requests when D1 is not configured', async () => {
		await expect(maintenanceService.repair({ env: {} }, 'indexes')).rejects.toThrow('D1 binding is missing');
	});

	it('rejects unknown repair actions', async () => {
		const c = { env: { db: { prepare: vi.fn() } } };

		await expect(maintenanceService.repair(c, 'unknown')).rejects.toThrow('Unknown maintenance action');
	});

	it('rebuilds search table by clearing only the derived search index', async () => {
		const statements = [];
		const c = {
			env: {
				db: {
					prepare(sql) {
						statements.push(sql);
						return {
							async run() {},
							async all() {
								return { results: [{ emailId: 1 }, { emailId: 2 }] };
							}
						};
					}
				}
			}
		};
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		await maintenanceService.repair(c, 'search');

		expect(dbInit.runOptionalSqlList).toHaveBeenCalled();
		expect(statements).toContain('DELETE FROM email_search');
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [1, 2]);
	});

	it('repairs code indexes with the expected index statements', async () => {
		const c = { env: { db: { prepare: vi.fn() } } };
		vi.spyOn(maintenanceService, 'health').mockResolvedValue({ ok: true });

		await maintenanceService.repair(c, 'indexes');

		const sqlList = dbInit.runOptionalSqlList.mock.calls[0][1].join('\n');
		expect(sqlList).toContain('idx_email_user_code_id');
		expect(sqlList).toContain('idx_email_code_id');
	});
});

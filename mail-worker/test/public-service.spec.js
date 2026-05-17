import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/service/role-service', () => ({
	default: {
		roleSelectUse: async () => [{ roleId: 1, name: 'default', isDefault: 1 }]
	}
}));

const { default: publicService } = await import('../src/service/public-service');

describe('public service import safety', () => {
	it('uses bound SQL parameters for public user imports', async () => {
		const statements = [];
		const c = {
			env: {
				domain: ['example.com'],
				db: {
					prepare(sql) {
						const statement = {
							sql,
							bindings: [],
							bind(...args) {
								this.bindings = args;
								return this;
							}
						};
						statements.push(statement);
						return statement;
					},
					async batch() {}
				}
			},
			req: {
				header() {
					return '';
				}
			}
		};

		await publicService.addUser(c, {
			list: [{ email: "safe@example.com", password: "123456" }]
		});

		const insertUser = statements.find(item => item.sql.includes('INSERT INTO user'));
		const insertAccount = statements.find(item => item.sql.includes('INSERT INTO account'));

		expect(insertUser.sql).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
		expect(insertUser.bindings[0]).toBe('safe@example.com');
		expect(insertAccount.sql).toContain('VALUES (?, ?, 0)');
		expect(insertAccount.bindings[0]).toBe('safe@example.com');
	});

	it('rejects invalid public user import payloads', async () => {
		await expect(publicService.addUser({ env: {} }, { list: 'not-array' })).rejects.toThrow('list must be an array');
		await expect(publicService.addUser({ env: {} }, { list: [null] })).rejects.toThrow('list item must be an object');
	});
});

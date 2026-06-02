import { describe, expect, it, vi } from 'vitest';

const ormState = vi.hoisted(() => ({
	rows: []
}));

function projectRow(row, fields) {
	const result = {};
	for (const key of Object.keys(fields)) {
		if (key === 'previewText') {
			result.previewText = row.previewText ?? row.text?.slice(0, 240) ?? '';
			continue;
		}
		result[key] = row[key];
	}
	return result;
}

vi.mock('../src/entity/orm', () => ({
	default: vi.fn(() => ({
		select(fields) {
			const query = {
				from() {
					return query;
				},
				where() {
					return query;
				},
				orderBy() {
					return query;
				},
				limit() {
					return {
						offset() {
							return ormState.rows.map(row => projectRow(row, fields));
						}
					};
				}
			};
			return query;
		}
	}))
}));

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

	it('returns only preview text from public email list by default', async () => {
		ormState.rows = [{
			emailId: 1,
			sendEmail: 'sender@example.com',
			sendName: 'Sender',
			subject: 'Subject',
			toEmail: 'user@example.com',
			toName: 'User',
			type: 0,
			createTime: '2026-06-02 08:00:00',
			content: '<p>full html body</p>',
			text: 'full plain text body',
			isDel: 0
		}];

		const list = await publicService.emailList({ env: {} }, {});

		expect(list).toEqual([{
			emailId: 1,
			sendEmail: 'sender@example.com',
			sendName: 'Sender',
			subject: 'Subject',
			toEmail: 'user@example.com',
			toName: 'User',
			type: 0,
			createTime: '2026-06-02 08:00:00',
			previewText: 'full plain text body',
			isDel: 0
		}]);
		expect(list[0]).not.toHaveProperty('content');
		expect(list[0]).not.toHaveProperty('text');
	});

	it('keeps full public email content only when includeContent is explicit', async () => {
		ormState.rows = [{
			emailId: 2,
			sendEmail: 'sender@example.com',
			sendName: 'Sender',
			subject: 'Subject',
			toEmail: 'user@example.com',
			toName: 'User',
			type: 0,
			createTime: '2026-06-02 08:00:00',
			content: '<p>full html body</p>',
			text: 'full plain text body',
			isDel: 0
		}];

		const list = await publicService.emailList({ env: {} }, { includeContent: true });

		expect(list[0]).toMatchObject({
			emailId: 2,
			content: '<p>full html body</p>',
			text: 'full plain text body',
			previewText: 'full plain text body'
		});
	});
});

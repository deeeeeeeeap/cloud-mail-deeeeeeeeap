import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emailConst, isDel, settingConst } from '../src/const/entity-const';

const mockState = vi.hoisted(() => ({
	selectResults: [],
	updates: []
}));

vi.mock('../src/entity/orm', () => ({
	default: vi.fn(() => ({
		select() {
			return {
				from() {
					return {
						where() {
							return {
								async all() {
									return mockState.selectResults.shift() || [];
								}
							};
						}
					};
				}
			};
		},
		update() {
			return {
				set(values) {
					mockState.updates.push(values);
					return {
						where() {
							return {
								async run() {
									return { success: true };
								}
							};
						}
					};
				}
			};
		},
		insert() {
			return {
				values() {
					return {
						returning() {
							return {
								async get() {
									return { emailId: 1001, accountId: 1, userId: 1 };
								}
							};
						},
						async run() {
							return { success: true };
						}
					};
				}
			};
		}
	}))
}));

vi.mock('../src/service/email-search-service', () => ({
	default: {
		syncEmailIds: vi.fn(),
		removeEmailIds: vi.fn()
	}
}));

vi.mock('../src/service/setting-service', () => ({
	default: {
		query: vi.fn(async () => ({ noRecipient: settingConst.noRecipient.CLOSE }))
	}
}));

vi.mock('../src/service/role-service', () => ({
	default: {
		selectByUserIds: vi.fn(async () => []),
		hasAvailDomainPerm: vi.fn(() => true),
		isBanEmail: vi.fn(() => false)
	}
}));

const { default: emailSearchService } = await import('../src/service/email-search-service');
const { default: emailService } = await import('../src/service/email-service');

function createDbRecorder(selectRows = []) {
	const statements = [];
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
						return { results: selectRows };
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

describe('email service status synchronization', () => {
	beforeEach(() => {
		mockState.selectResults = [];
		mockState.updates = [];
		vi.clearAllMocks();
	});

	it('syncs the sender row after an internal recipient bounce changes its status', async () => {
		const c = { env: { admin: 'admin@example.com', db: createDbRecorder().db } };
		mockState.selectResults = [[]];

		await emailService.HandleOnSiteEmail(c, ['missing@example.com'], {
			emailId: 99,
			sendEmail: 'sender@example.com',
			status: emailConst.status.DELIVERED,
			type: emailConst.type.SEND
		}, []);

		expect(mockState.updates[0]).toMatchObject({ status: emailConst.status.BOUNCED });
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [99]);
	});

	it('only completes non-deleted SAVING messages and syncs the affected search rows', async () => {
		const recorder = createDbRecorder([{ emailId: 1 }, { emailId: 2 }]);
		const c = { env: { db: recorder.db } };
		mockState.selectResults = [[{ emailId: 1 }, { emailId: 2 }]];

		await emailService.completeReceiveAll(c);

		const updateStatements = recorder.statements.filter(statement => statement.sql.includes('UPDATE email'));
		expect(updateStatements).toHaveLength(2);
		expect(updateStatements.every(statement => statement.sql.includes('is_del'))).toBe(true);
		expect(updateStatements[0].bindings).toEqual([emailConst.status.RECEIVE, emailConst.status.SAVING, isDel.NORMAL]);
		expect(updateStatements[1].bindings).toEqual([emailConst.status.NOONE, emailConst.status.SAVING, isDel.NORMAL]);
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [1, 2]);
	});
});

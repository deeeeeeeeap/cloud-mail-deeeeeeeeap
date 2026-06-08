import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emailConst, isDel, settingConst } from '../src/const/entity-const';

const mockState = vi.hoisted(() => ({
	selectResults: [],
	updates: [],
	insertValues: [],
	operationLog: [],
	settingResult: {},
	userRow: {},
	roleRow: {},
	accountRow: {},
	imageResult: { imageDataList: [], html: '<p>Hello</p>' }
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
					mockState.operationLog.push({ type: 'update', values });
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
				values(values) {
					mockState.insertValues.push(values);
					mockState.operationLog.push({ type: 'insert', values });
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
		query: vi.fn(async () => mockState.settingResult)
	}
}));

vi.mock('../src/service/role-service', () => ({
	default: {
		selectById: vi.fn(async () => mockState.roleRow),
		selectByUserIds: vi.fn(async () => []),
		hasAvailDomainPerm: vi.fn(() => true),
		isBanEmail: vi.fn(() => false)
	}
}));

vi.mock('../src/service/user-service', () => ({
	default: {
		selectById: vi.fn(async () => mockState.userRow),
		incrUserSendCount: vi.fn(async () => {
			mockState.operationLog.push({ type: 'incrUserSendCount' });
		})
	}
}));

vi.mock('../src/service/account-service', () => ({
	default: {
		selectById: vi.fn(async () => mockState.accountRow)
	}
}));

vi.mock('../src/service/att-service', () => ({
	default: {
		toImageUrlHtml: vi.fn(async () => mockState.imageResult),
		saveArticleAtt: vi.fn(async () => {
			mockState.operationLog.push({ type: 'saveArticleAtt' });
		}),
		saveSendAtt: vi.fn(async () => {
			mockState.operationLog.push({ type: 'saveSendAtt' });
		}),
		selectByEmailIds: vi.fn(async () => [])
	}
}));

const { default: emailSearchService } = await import('../src/service/email-search-service');
const { default: attService } = await import('../src/service/att-service');
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
		mockState.insertValues = [];
		mockState.operationLog = [];
		mockState.settingResult = {
			noRecipient: settingConst.noRecipient.CLOSE,
			resendTokens: {},
			r2Domain: 'https://assets.example.com',
			send: settingConst.send.OPEN,
			domainList: ['@internal.example.com']
		};
		mockState.userRow = {
			userId: 1,
			email: 'sender@example.com',
			type: 1,
			sendCount: 0
		};
		mockState.roleRow = {
			sendType: 'count',
			sendCount: 0,
			availDomain: ''
		};
		mockState.accountRow = {
			accountId: 1,
			userId: 1,
			email: 'sender@example.com'
		};
		mockState.imageResult = { imageDataList: [], html: '<p>Hello</p>' };
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
		expect(updateStatements[0].bindings).toEqual([emailConst.status.RECEIVE, emailConst.status.SAVING, isDel.NORMAL, emailConst.type.RECEIVE]);
		expect(updateStatements[1].bindings).toEqual([emailConst.status.NOONE, emailConst.status.SAVING, isDel.NORMAL, emailConst.type.RECEIVE]);
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [1, 2]);
	});

	it('rejects too many outbound attachments before local insert or provider send', async () => {
		const sendMock = vi.fn();
		const c = {
			env: {
				admin: 'admin@example.com',
				email: { send: sendMock },
				kv: {
					get: vi.fn(),
					put: vi.fn()
				}
			}
		};

		await expect(emailService.send(c, {
			accountId: 1,
			name: 'Sender',
			sendType: 'new',
			receiveEmail: ['to@external.example.com'],
			text: 'Hello',
			content: '<p>Hello</p>',
			subject: 'Hello',
			attachments: Array.from({ length: 11 }, (_, index) => ({
				filename: `file-${index}.txt`,
				type: 'text/plain',
				content: 'YQ=='
			}))
		}, 1)).rejects.toThrow();

		expect(sendMock).not.toHaveBeenCalled();
		expect(mockState.insertValues).toHaveLength(0);
		expect(attService.saveSendAtt).not.toHaveBeenCalled();
	});

	it('persists outbound row and attachments before external provider send', async () => {
		const sendMock = vi.fn(async () => {
			mockState.operationLog.push({ type: 'provider' });
			return { messageId: 'cf-message-1' };
		});
		const c = {
			env: {
				admin: 'admin@example.com',
				email: { send: sendMock },
				kv: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {})
				}
			}
		};

		const [emailResult] = await emailService.send(c, {
			accountId: 1,
			name: 'Sender',
			sendType: 'new',
			receiveEmail: ['to@external.example.com'],
			text: 'Hello',
			content: '<p>Hello</p>',
			subject: 'Hello',
			attachments: [{
				filename: 'hello.txt',
				type: 'text/plain',
				content: 'YQ=='
			}]
		}, 1);

		const operationTypes = mockState.operationLog.map(operation => operation.type);
		expect(operationTypes.indexOf('insert')).toBeLessThan(operationTypes.indexOf('saveSendAtt'));
		expect(operationTypes.indexOf('saveSendAtt')).toBeLessThan(operationTypes.indexOf('provider'));
		expect(operationTypes.indexOf('provider')).toBeLessThan(operationTypes.lastIndexOf('update'));
		expect(mockState.insertValues[0].status).toBe(emailConst.status.SAVING);
		expect(mockState.updates.at(-1)).toMatchObject({
			status: emailConst.status.DELIVERED,
			resendEmailId: 'cf-message-1'
		});
		expect(emailResult.status).toBe(emailConst.status.DELIVERED);
		expect(emailResult.resendEmailId).toBe('cf-message-1');
	});
});

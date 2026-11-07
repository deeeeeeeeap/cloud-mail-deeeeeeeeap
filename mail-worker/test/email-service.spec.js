import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emailConst, isDel, settingConst } from '../src/const/entity-const';

function base64ForDecodedSize(size) {
	const padding = (3 - size % 3) % 3;
	return 'A'.repeat(Math.ceil(size / 3) * 4 - padding) + '='.repeat(padding);
}

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
		selectById: vi.fn(async () => mockState.userRow)
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
		reconcileReceived: vi.fn(),
		saveArticleAtt: vi.fn(async () => {
			mockState.operationLog.push({ type: 'saveArticleAtt' });
		}),
		saveSendAtt: vi.fn(async () => {
			mockState.operationLog.push({ type: 'saveSendAtt' });
		}),
		countByEmailIds: vi.fn(async () => []),
		selectByEmailIds: vi.fn(async () => [])
	}
}));

vi.mock('../src/service/delivery-attempt-service', () => ({
	deliveryAttemptConst: {
		provider: {
			CLOUDFLARE_EMAIL: 'CLOUDFLARE_EMAIL',
			RESEND: 'RESEND'
		},
		status: {
			PREPARED: 'PREPARED',
			IN_FLIGHT: 'IN_FLIGHT',
			PENDING_ACK: 'PENDING_ACK',
			ACCEPTED: 'ACCEPTED',
			FAILED: 'FAILED',
			UNKNOWN: 'UNKNOWN'
		}
	},
	default: {
		prepare: vi.fn(async () => {
			mockState.operationLog.push({ type: 'attempt-prepared' });
			return {
				attemptId: 701,
				attemptKey: 'cloud-mail/1001/stable-attempt'
			};
		}),
		markInFlight: vi.fn(async () => {
			mockState.operationLog.push({ type: 'attempt-in-flight' });
		}),
		markAccepted: vi.fn(async () => {
			mockState.operationLog.push({ type: 'attempt-accepted' });
		}),
		markPendingAck: vi.fn(async () => {
			mockState.operationLog.push({ type: 'attempt-pending-ack' });
		}),
		markFailed: vi.fn(async () => {
			mockState.operationLog.push({ type: 'attempt-failed' });
		}),
		markPreparationFailed: vi.fn(async () => {
			mockState.operationLog.push({ type: 'attempt-preparation-failed' });
		}),
		markUnknown: vi.fn(async () => {
			mockState.operationLog.push({ type: 'attempt-unknown' });
		})
	}
}));

const { default: emailSearchService } = await import('../src/service/email-search-service');
const { default: attService } = await import('../src/service/att-service');
const { default: deliveryAttemptService } = await import('../src/service/delivery-attempt-service');
const { default: emailService } = await import('../src/service/email-service');

function createDbRecorder(selectRows = [], onRun = null) {
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
					async first() {
						return selectRows[0] || null;
					},
					async run() {
						if (onRun) {
							return onRun(this);
						}
						return { success: true };
					}
				};
				statements.push(statement);
				return statement;
			}
		}
	};
}

describe('email list attachment projection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns only attachment counts for lite rows without loading attachment metadata', async () => {
		attService.countByEmailIds.mockResolvedValueOnce([
			{ emailId: 41, attCount: 2 }
		]);
		const list = [{ emailId: 41 }, { emailId: 42 }];

		await emailService.emailAddAtt({ env: {} }, list, { lite: true });

		expect(attService.countByEmailIds).toHaveBeenCalledWith({ env: {} }, [41, 42]);
		expect(attService.selectByEmailIds).not.toHaveBeenCalled();
		expect(list).toEqual([
			{ emailId: 41, attCount: 2, attList: [] },
			{ emailId: 42, attCount: 0, attList: [] }
		]);
	});

	it('keeps full attachment metadata for detail rows', async () => {
		attService.selectByEmailIds.mockResolvedValueOnce([
			{ emailId: 51, filename: 'report.pdf', size: 4096 }
		]);
		const list = [{ emailId: 51 }];

		await emailService.emailAddAtt({ env: {} }, list);

		expect(attService.countByEmailIds).not.toHaveBeenCalled();
		expect(attService.selectByEmailIds).toHaveBeenCalled();
		expect(list).toEqual([{
			emailId: 51,
			attCount: 1,
			attList: [{ emailId: 51, filename: 'report.pdf', size: 4096 }]
		}]);
	});
});

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

		it('reconciles stale SAVING messages in a bounded batch instead of blindly publishing them', async () => {
			const recorder = createDbRecorder([{
				emailId: 1,
				attachmentCount: 1,
				recipientExists: 1
			}]);
			const c = { env: { db: recorder.db } };
			attService.reconcileReceived.mockResolvedValue({
				total: 1,
				ready: 0,
				pending: 0,
				failed: 1
			});

			await emailService.completeReceiveAll(c);

			const selectStatement = recorder.statements.find(statement => statement.sql.includes('attachment_count'));
			expect(selectStatement.sql).not.toContain('is_del = ?');
			expect(selectStatement.sql).toContain("datetime('now', '-10 minutes')");
		expect(selectStatement.sql).toContain('LIMIT 2');
			expect(attService.reconcileReceived).toHaveBeenCalledWith(c, 1);
			expect(mockState.updates[0]).toEqual({
				isDel: isDel.NORMAL,
				status: emailConst.status.FAILED,
				message: 'ATTACHMENT_RECOVERY_FAILED',
				recoveryAfter: null
			});
			expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [1]);
		});

		it('stores only bounded allowlisted incoming failure codes', async () => {
			const c = { env: { db: createDbRecorder().db } };

			await emailService.failReceive(c, 55, `provider secret ${'x'.repeat(500)}`);

			expect(mockState.updates[0]).toEqual({
				isDel: isDel.NORMAL,
				status: emailConst.status.FAILED,
				message: 'RECEIVE_FAILED',
				recoveryAfter: null
			});
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [55]);
	});

	it('updates AI-extracted codes only while the code field is still empty', async () => {
		const recorder = createDbRecorder();
		const c = { env: { db: recorder.db } };

		await emailService.updateCode(c, 55, 'AB12CD');

		const updateStatement = recorder.statements.find(statement => statement.sql.includes('UPDATE email'));
		expect(updateStatement.sql).toContain("WHERE email_id = ? AND code = ''");
		expect(updateStatement.bindings).toEqual(['AB12CD', 55]);
		expect(emailSearchService.syncEmailIds).toHaveBeenCalledWith(c, [55]);
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

	it('allows a 3 MiB attachment below the Cloudflare Email limit', async () => {
		const sendMock = vi.fn(async () => ({ messageId: 'cf-three-mib' }));
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

		await emailService.send(c, {
			accountId: 1,
			name: 'Sender',
			receiveEmail: ['to@external.example.com'],
			text: 'See attachment',
			content: '<p>See attachment</p>',
			subject: '3 MiB PDF',
			attachments: [{
				filename: 'report.pdf',
				contentType: 'application/pdf',
				content: base64ForDecodedSize(3 * 1024 * 1024)
			}]
		}, 1);

		expect(sendMock).toHaveBeenCalledOnce();
		expect(sendMock.mock.calls[0][0].attachments[0]).toMatchObject({
			filename: 'report.pdf',
			type: 'application/pdf',
			disposition: 'attachment'
		});
		expect(sendMock.mock.calls[0][0].attachments[0].content.byteLength).toBe(3 * 1024 * 1024);
	});

	it('rejects Cloudflare Email messages over 25 MiB before persistence', async () => {
		const sendMock = vi.fn();
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

		await expect(emailService.send(c, {
			accountId: 1,
			name: 'Sender',
			receiveEmail: ['to@external.example.com'],
			text: 'Hello',
			content: '<p>Hello</p>',
			subject: 'Hello',
			attachments: [{
				filename: 'large.bin',
				contentType: 'application/octet-stream',
				content: base64ForDecodedSize(19 * 1024 * 1024)
			}]
		}, 1)).rejects.toMatchObject({
			code: 413,
			message: 'Cloudflare Email message exceeds 25 MiB limit'
		});

		expect(mockState.insertValues).toHaveLength(0);
		expect(attService.saveSendAtt).not.toHaveBeenCalled();
		expect(sendMock).not.toHaveBeenCalled();
	});

	it('rejects Resend messages over 40 MB before persistence', async () => {
		mockState.settingResult.resendTokens = { 'example.com': 're_test' };
		const providerSpy = vi.spyOn(emailService, 'sendByResend').mockResolvedValue({
			data: { id: 'resend-message-1' }
		});
		const content = base64ForDecodedSize(15 * 1024 * 1024);
		const c = {
			env: {
				admin: 'admin@example.com',
				kv: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {})
				}
			}
		};

		try {
			await expect(emailService.send(c, {
				accountId: 1,
				name: 'Sender',
				receiveEmail: ['to@external.example.com'],
				text: 'Hello',
				content: '<p>Hello</p>',
				subject: 'Hello',
				attachments: [0, 1].map(index => ({
					filename: `part-${index}.bin`,
					contentType: 'application/octet-stream',
					content
				}))
			}, 1)).rejects.toMatchObject({
				code: 413,
				message: 'Resend message exceeds 40 MB limit'
			});

			expect(mockState.insertValues).toHaveLength(0);
			expect(attService.saveSendAtt).not.toHaveBeenCalled();
			expect(providerSpy).not.toHaveBeenCalled();
		} finally {
			providerSpy.mockRestore();
		}
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
		expect(operationTypes.indexOf('saveSendAtt')).toBeLessThan(operationTypes.indexOf('attempt-prepared'));
		expect(operationTypes.indexOf('attempt-prepared')).toBeLessThan(operationTypes.indexOf('attempt-in-flight'));
		expect(operationTypes.indexOf('attempt-in-flight')).toBeLessThan(operationTypes.indexOf('provider'));
		expect(operationTypes.indexOf('provider')).toBeLessThan(operationTypes.indexOf('attempt-accepted'));
		expect(operationTypes.indexOf('provider')).toBeLessThan(operationTypes.lastIndexOf('update'));
		expect(mockState.insertValues[0].status).toBe(emailConst.status.SAVING);
		expect(mockState.updates.at(-1)).toMatchObject({
			status: emailConst.status.DELIVERED,
			resendEmailId: 'cf-message-1'
		});
		expect(emailResult.status).toBe(emailConst.status.DELIVERED);
		expect(emailResult.resendEmailId).toBe('cf-message-1');
	});

	it('records PENDING_ACK and returns success when provider acceptance cannot be finalized locally', async () => {
		const sendMock = vi.fn(async () => ({ messageId: 'cf-message-pending-ack' }));
		deliveryAttemptService.markAccepted.mockRejectedValueOnce(new Error('temporary D1 failure'));
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
			subject: 'Hello'
		}, 1);

		expect(sendMock).toHaveBeenCalledOnce();
		expect(mockState.operationLog.map(operation => operation.type))
			.toContain('attempt-pending-ack');
		expect(emailResult).toMatchObject({
			status: emailConst.status.DELIVERED,
			resendEmailId: 'cf-message-pending-ack'
		});
	});

	it('passes the stable attempt key to Resend as its idempotency key', async () => {
		mockState.settingResult.resendTokens = {
			'example.com': 'test-resend-token'
		};
		const providerSpy = vi.spyOn(emailService, 'sendByResend').mockResolvedValue({
			data: { id: 'resend-message-idempotent' },
			error: null
		});
		const c = {
			env: {
				admin: 'admin@example.com',
				kv: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {})
				}
			}
		};

		try {
			await emailService.send(c, {
				accountId: 1,
				name: 'Sender',
				sendType: 'new',
				receiveEmail: ['to@external.example.com'],
				text: 'Hello',
				content: '<p>Hello</p>',
				subject: 'Hello'
			}, 1);

			expect(providerSpy).toHaveBeenCalledWith(
				'test-resend-token',
				expect.objectContaining({ emailId: 1001 }),
				'cloud-mail/1001/stable-attempt'
			);
		} finally {
			providerSpy.mockRestore();
		}
	});

	it('does not create an external delivery attempt for an internal-only send', async () => {
		const onsiteSpy = vi.spyOn(emailService, 'HandleOnSiteEmail').mockResolvedValue();
		const c = {
			env: {
				admin: 'admin@example.com',
				kv: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {})
				}
			}
		};

		try {
			await emailService.send(c, {
				accountId: 1,
				name: 'Sender',
				sendType: 'new',
				receiveEmail: ['to@internal.example.com'],
				text: 'Hello',
				content: '<p>Hello</p>',
				subject: 'Hello'
			}, 1);

			expect(onsiteSpy).toHaveBeenCalledOnce();
			expect(deliveryAttemptService.prepare).not.toHaveBeenCalled();
		} finally {
			onsiteSpy.mockRestore();
		}
	});

	it('marks outbound mail failed when local attachment storage fails', async () => {
		const sendMock = vi.fn();
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
		attService.saveSendAtt.mockRejectedValueOnce(new Error('object upload failed'));

		await expect(emailService.send(c, {
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
		}, 1)).rejects.toThrow('object upload failed');

		expect(sendMock).not.toHaveBeenCalled();
		expect(mockState.updates.at(-1)).toMatchObject({
			status: emailConst.status.FAILED,
			message: 'object upload failed'
		});
	});

	it('does not call the provider when the durable attempt cannot enter IN_FLIGHT', async () => {
		const sendMock = vi.fn();
		deliveryAttemptService.markInFlight.mockRejectedValueOnce(new Error('D1 unavailable'));
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

		await expect(emailService.send(c, {
			accountId: 1,
			name: 'Sender',
			sendType: 'new',
			receiveEmail: ['to@external.example.com'],
			text: 'Hello',
			content: '<p>Hello</p>',
			subject: 'Hello'
		}, 1)).rejects.toThrow('D1 unavailable');

		expect(deliveryAttemptService.prepare).toHaveBeenCalledOnce();
		expect(sendMock).not.toHaveBeenCalled();
		expect(deliveryAttemptService.markAccepted).not.toHaveBeenCalled();
	});

	it('marks a local attachment preparation failure as FAILED before any provider call', async () => {
		const sendMock = vi.fn(async () => ({ messageId: 'unused' }));
		const preparationSpy = vi.spyOn(emailService, 'toCloudflareAttachments')
			.mockRejectedValue(new Error('broken base64 attachment'));
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

		try {
			await expect(emailService.send(c, {
				accountId: 1,
				name: 'Sender',
				sendType: 'new',
				receiveEmail: ['to@external.example.com'],
				text: 'Hello',
				content: '<p>Hello</p>',
				subject: 'Hello'
			}, 1)).rejects.toThrow('broken base64 attachment');

			const operationTypes = mockState.operationLog.map(operation => operation.type);
			expect(operationTypes).toContain('attempt-preparation-failed');
			expect(operationTypes).not.toContain('attempt-in-flight');
			expect(operationTypes).not.toContain('attempt-unknown');
			expect(sendMock).not.toHaveBeenCalled();
			expect(mockState.updates.at(-1)).toMatchObject({
				status: emailConst.status.FAILED,
				message: 'LOCAL_PREPARATION_FAILED'
			});
		} finally {
			preparationSpy.mockRestore();
		}
	});

	it('records an UNKNOWN attempt instead of FAILED when the provider call outcome is ambiguous', async () => {
		const sendMock = vi.fn(async () => {
			throw new Error('connection reset after request write');
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

		await expect(emailService.send(c, {
			accountId: 1,
			name: 'Sender',
			sendType: 'new',
			receiveEmail: ['to@external.example.com'],
			text: 'Hello',
			content: '<p>Hello</p>',
			subject: 'Hello'
		}, 1)).rejects.toMatchObject({
			code: 502,
			message: 'Delivery outcome is unknown; do not retry automatically'
		});

		const operationTypes = mockState.operationLog.map(operation => operation.type);
		expect(operationTypes).toContain('attempt-unknown');
		expect(operationTypes).not.toContain('attempt-failed');
		expect(mockState.updates.at(-1)).toMatchObject({
			status: emailConst.status.SAVING,
			message: 'DELIVERY_OUTCOME_UNKNOWN'
		});
	});

	it('marks a documented Cloudflare Email rejection as FAILED', async () => {
		const providerError = Object.assign(new Error('sender domain is not verified'), {
			code: 'E_SENDER_NOT_VERIFIED'
		});
		const sendMock = vi.fn(async () => {
			throw providerError;
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

		await expect(emailService.send(c, {
			accountId: 1,
			name: 'Sender',
			sendType: 'new',
			receiveEmail: ['to@external.example.com'],
			text: 'Hello',
			content: '<p>Hello</p>',
			subject: 'Hello'
		}, 1)).rejects.toThrow('sender domain is not verified');

		const operationTypes = mockState.operationLog.map(operation => operation.type);
		expect(operationTypes).toContain('attempt-failed');
		expect(operationTypes).not.toContain('attempt-unknown');
		expect(mockState.updates.at(-1)).toMatchObject({
			status: emailConst.status.FAILED,
			message: 'DELIVERY_PROVIDER_REJECTED'
		});
	});

	it('treats a Resend 5xx response as UNKNOWN instead of an explicit rejection', async () => {
		mockState.settingResult.resendTokens = {
			'example.com': 'test-resend-token'
		};
		const providerSpy = vi.spyOn(emailService, 'sendByResend').mockResolvedValue({
			data: null,
			error: {
				message: 'Resend is temporarily unavailable',
				statusCode: 503,
				name: 'application_error'
			}
		});
		const c = {
			env: {
				admin: 'admin@example.com',
				kv: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {})
				}
			}
		};

		try {
			await expect(emailService.send(c, {
				accountId: 1,
				name: 'Sender',
				sendType: 'new',
				receiveEmail: ['to@external.example.com'],
				text: 'Hello',
				content: '<p>Hello</p>',
				subject: 'Hello'
			}, 1)).rejects.toMatchObject({
				code: 502,
				message: 'Delivery outcome is unknown; do not retry automatically'
			});

			const operationTypes = mockState.operationLog.map(operation => operation.type);
			expect(operationTypes).toContain('attempt-unknown');
			expect(operationTypes).not.toContain('attempt-failed');
			expect(mockState.updates.at(-1)).toMatchObject({
				status: emailConst.status.SAVING,
				message: 'DELIVERY_OUTCOME_UNKNOWN'
			});
		} finally {
			providerSpy.mockRestore();
		}
	});

	it('treats a concurrent Resend idempotency request as UNKNOWN', async () => {
		mockState.settingResult.resendTokens = {
			'example.com': 'test-resend-token'
		};
		const providerSpy = vi.spyOn(emailService, 'sendByResend').mockResolvedValue({
			data: null,
			error: {
				message: 'A request with this idempotency key is still processing',
				statusCode: 409,
				name: 'concurrent_idempotent_requests'
			}
		});
		const c = {
			env: {
				admin: 'admin@example.com',
				kv: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {})
				}
			}
		};

		try {
			await expect(emailService.send(c, {
				accountId: 1,
				name: 'Sender',
				sendType: 'new',
				receiveEmail: ['to@external.example.com'],
				text: 'Hello',
				content: '<p>Hello</p>',
				subject: 'Hello'
			}, 1)).rejects.toMatchObject({ code: 502 });

			const operationTypes = mockState.operationLog.map(operation => operation.type);
			expect(operationTypes).toContain('attempt-unknown');
			expect(operationTypes).not.toContain('attempt-failed');
		} finally {
			providerSpy.mockRestore();
		}
	});

	it('marks the attempt and email FAILED when Resend explicitly rejects the request', async () => {
		mockState.settingResult.resendTokens = {
			'example.com': 'test-resend-token'
		};
		const providerSpy = vi.spyOn(emailService, 'sendByResend').mockResolvedValue({
			data: null,
			error: { message: 'domain is not verified' }
		});
		const c = {
			env: {
				admin: 'admin@example.com',
				kv: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {})
				}
			}
		};

		try {
			await expect(emailService.send(c, {
				accountId: 1,
				name: 'Sender',
				sendType: 'new',
				receiveEmail: ['to@external.example.com'],
				text: 'Hello',
				content: '<p>Hello</p>',
				subject: 'Hello'
			}, 1)).rejects.toThrow('domain is not verified');

			const operationTypes = mockState.operationLog.map(operation => operation.type);
			expect(operationTypes).toContain('attempt-failed');
			expect(operationTypes).not.toContain('attempt-unknown');
			expect(mockState.updates.at(-1)).toMatchObject({
				status: emailConst.status.FAILED,
				message: 'DELIVERY_PROVIDER_REJECTED'
			});
		} finally {
			providerSpy.mockRestore();
		}
	});

	it('keeps an atomically reserved send attempt counted when local storage fails', async () => {
		let reservedCount = 0;
		const recorder = createDbRecorder([], statement => {
			if (statement.sql.includes('UPDATE user') && statement.sql.includes('SET send_count')) {
				reservedCount += statement.bindings[0];
				return { success: true, meta: { changes: 1 } };
			}
			return { success: true };
		});
		const sendMock = vi.fn();
		const c = {
			env: {
				admin: 'admin@example.com',
				db: recorder.db,
				email: { send: sendMock },
				kv: {
					get: vi.fn(async () => null),
					put: vi.fn(async () => {})
				}
			}
		};
		mockState.roleRow = {
			roleId: 1,
			sendType: 'count',
			sendCount: 2,
			availDomain: ''
		};
		attService.saveSendAtt.mockRejectedValueOnce(new Error('object upload failed'));

		await expect(emailService.send(c, {
			accountId: 1,
			name: 'Sender',
			receiveEmail: ['to@external.example.com'],
			text: 'Hello',
			content: '<p>Hello</p>',
			subject: 'Hello',
			attachments: [{
				filename: 'hello.txt',
				contentType: 'text/plain',
				content: 'YQ=='
			}]
		}, 1)).rejects.toThrow('object upload failed');

		expect(reservedCount).toBe(1);
		expect(recorder.statements.filter(statement => statement.sql.includes('UPDATE user')))
			.toHaveLength(1);
		expect(sendMock).not.toHaveBeenCalled();
	});
});

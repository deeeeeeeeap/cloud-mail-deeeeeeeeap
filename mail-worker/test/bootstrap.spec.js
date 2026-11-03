import { createExecutionContext, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src';

describe('first deployment bootstrap', () => {
	it('returns a retryable error instead of setup instructions when D1 cannot be checked', async () => {
		const faultDb = {
			prepare() { return { bind() { return this; } }; },
			async batch() { throw new Error('private database failure details'); }
		};
		for (const path of ['/init/status', '/setting/websiteConfig']) {
			const ctx = createExecutionContext();
			const response = await worker.fetch(new Request(`http://example.com/api${path}`), { db: faultDb }, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(503);
			const body = await response.json();
			expect(body.code).toBe(503);
			expect(body.data).toBeUndefined();
			expect(JSON.stringify(body)).not.toContain('private database');
		}
	});

	it('reports missing bindings and variables without throwing', async () => {
		const request = new Request('http://example.com/api/init/status');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, {}, ctx);
		await waitOnExecutionContext(ctx);
		const body = await response.json();

		expect(body).toMatchObject({
			code: 200,
			data: {
				initialized: false,
				ready: false,
				bindings: { d1: false, kv: false, assets: false },
				configuration: { domain: false, admin: false, initSecret: false }
			}
		});
	});

	it('keeps the setup page usable until database and administrator bootstrap both finish', async () => {
		const statusBeforeResponse = await SELF.fetch('http://example.com/api/init/status');
		expect(statusBeforeResponse.status).toBe(200);
		const statusBefore = await statusBeforeResponse.json();
		expect(statusBefore).toMatchObject({
			code: 200,
			data: {
				initialized: false,
				ready: false
			}
		});
		const serializedStatus = JSON.stringify(statusBefore);
		expect(serializedStatus).not.toContain('jwt_secret');
		expect(serializedStatus).not.toContain('your-jwt-secret');
		expect(serializedStatus).not.toContain('admin@example.com');
		expect(serializedStatus).not.toContain('example.com');

		const configBeforeResponse = await SELF.fetch('http://example.com/api/setting/websiteConfig');
		expect(configBeforeResponse.status).toBe(200);
		const configBefore = await configBeforeResponse.json();
		expect(configBefore).toMatchObject({
			code: 200,
			data: {
				initialized: false,
				register: 1,
				domainList: []
			}
		});

		const maintenanceResponse = await SELF.fetch('http://example.com/api/maintenance/health');
		const maintenanceBefore = await maintenanceResponse.json();
		expect(maintenanceResponse.status).toBe(401);
		expect(maintenanceBefore.code).toBe(401);

		const initResponse = await SELF.fetch('http://example.com/api/init', {
			method: 'POST',
			headers: { 'X-Cloud-Mail-Init-Secret': 'your-jwt-secret' }
		});
		expect(initResponse.status).toBe(200);
		expect(await initResponse.text()).toBe('success');

		const statusAfterResponse = await SELF.fetch('http://example.com/api/init/status');
		const statusAfter = await statusAfterResponse.json();
		expect(statusAfter).toMatchObject({
			code: 200,
			data: {
				initialized: true,
				adminCreated: false,
				ready: false
			}
		});

		const configAfterResponse = await SELF.fetch('http://example.com/api/setting/websiteConfig');
		const configAfter = await configAfterResponse.json();
		expect(configAfter).toMatchObject({
			code: 200,
			data: {
				initialized: true,
				adminCreated: false,
				ready: false
			}
		});

		const adminResponse = await SELF.fetch('http://example.com/api/init/admin', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Cloud-Mail-Init-Secret': 'your-jwt-secret'
			},
			body: JSON.stringify({ password: 'secure-admin-password' })
		});
		expect(adminResponse.status).toBe(200);
		expect(await adminResponse.text()).toBe('success');

		const readyStatus = await (await SELF.fetch('http://example.com/api/init/status')).json();
		expect(readyStatus).toMatchObject({
			code: 200,
			data: {
				initialized: true,
				adminCreated: true,
				ready: true
			}
		});
		const serializedReadyStatus = JSON.stringify(readyStatus);
		expect(serializedReadyStatus).not.toContain('secure-admin-password');
		expect(serializedReadyStatus).not.toContain('your-jwt-secret');
	});
});

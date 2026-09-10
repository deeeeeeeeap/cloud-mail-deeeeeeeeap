import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import oauthService from "./service/oauth-service";
// Inline attachments are served exclusively through authenticated API routes.
import r2Service from './service/r2-service';
import maintenanceService from './service/maintenance-service';
import authRateLimitService from './service/auth-rate-limit-service';
import deliveryAttemptService from './service/delivery-attempt-service';
import { withSecurityHeaders } from './security/response-security';

async function objectResponse(c, key) {
	const obj = await r2Service.getObj(c, key);
	return r2Service.toResponse(obj) || new Response('Not found', { status: 404 });
}

async function runScheduledTask(name, task) {
	try {
		await task();
	} catch (e) {
		console.error(`Scheduled task ${name} failed:`, e?.message || e);
	}
}

function isEnabled(value) {
	return value === true || value === 1 || value === 'true' || value === '1';
}

export default {
	async fetch(req, env, ctx) {

		const url = new URL(req.url)
		let response;

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			response = await app.fetch(req, env, ctx);
			return withSecurityHeaders(response);
		}

		if (url.pathname.startsWith('/attachments/')) {
			// Private mail resources must never be served by an anonymous object URL.
			return withSecurityHeaders(new Response('Not found', {
				status: 404, headers: { 'Cache-Control': 'private, no-store' }
			}));
		}

		if (url.pathname.startsWith('/static/')) {
			response = await objectResponse({ env }, url.pathname.substring(1));
			return withSecurityHeaders(response);
		}

		response = await env.assets.fetch(req);
		return withSecurityHeaders(response);
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/30 * * * *') {
			await runScheduledTask('complete-receive-all', () => emailService.completeReceiveAll({ env }, { limit: 2 }))
			await runScheduledTask('delivery-attempt-reconcile', () => deliveryAttemptService.reconcile({ env }, { limit: 2 }))
			await runScheduledTask('clear-expired-auth-failures', () => authRateLimitService.clearExpired({ env }))
			await runScheduledTask('clear-expired-oauth-security', () => oauthService.clearExpiredOAuthSecurity({ env }))
			return;
		}

		await runScheduledTask('verify-record-clear', () => verifyRecordService.clearRecord({ env }))
		await runScheduledTask('reset-day-send-count', () => userService.resetDaySendCount({ env }))
		await runScheduledTask('complete-receive-all', () => emailService.completeReceiveAll({ env }, { limit: 2 }))
		await runScheduledTask('delivery-attempt-reconcile', () => deliveryAttemptService.reconcile({ env }, { limit: 2 }))
		await runScheduledTask('clear-unbound-oauth-users', () => oauthService.clearNoBindOathUser({ env }))
		await runScheduledTask('clear-expired-auth-failures', () => authRateLimitService.clearExpired({ env }))
		if (isEnabled(env.code_clear_stale_cron)) {
			await runScheduledTask('codes-clear-stale', () => maintenanceService.clearStaleCodes({ env }, {
				staleMinutes: env.code_stale_minutes
			}))
		}
	},
};

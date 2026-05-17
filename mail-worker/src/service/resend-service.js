import emailService from './email-service';
import { emailConst } from '../const/entity-const';
import BizError from '../error/biz-error';
import secretUtils from '../utils/secret-utils';

const encoder = new TextEncoder();

const resendService = {

	async webhooks(c, rawBody) {
		await this.verifyWebhook(c, rawBody);
		const body = JSON.parse(rawBody);

		const params = {
			resendEmailId: body.data.email_id,
			status: emailConst.status.SENT
		}

		if (body.type === 'email.delivered') {
			params.status = emailConst.status.DELIVERED
			params.message = null
		}

		if (body.type === 'email.complained') {
			params.status = emailConst.status.COMPLAINED
			params.message = null
		}

		if (body.type === 'email.bounced') {
			let bounce = body.data.bounce
			bounce = JSON.stringify(bounce);
			params.status = emailConst.status.BOUNCED
			params.message = bounce
		}

		if (body.type === 'email.delivery_delayed') {
			params.status = emailConst.status.DELAYED
			params.message = null
		}

		if (body.type === 'email.failed') {
			params.status = emailConst.status.FAILED
			params.message = body.data.failed.reason
		}

		const emailRow = await emailService.updateEmailStatus(c, params)

		if (!emailRow) {
			throw new BizError('更新邮件状态记录失败');
		}

	},

	async verifyWebhook(c, rawBody) {
		const secret = c.env.resend_webhook_secret;
		if (!secret) {
			console.warn('resend_webhook_secret is not configured; skipping webhook signature verification.');
			return;
		}

		const id = c.req.header('svix-id');
		const timestamp = c.req.header('svix-timestamp');
		const signature = c.req.header('svix-signature');

		if (!id || !timestamp || !signature) {
			throw new BizError('Missing webhook signature headers', 401);
		}

		const now = Math.floor(Date.now() / 1000);
		const ts = Number(timestamp);
		if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
			throw new BizError('Webhook timestamp is outside the allowed tolerance', 401);
		}

		const payload = `${id}.${timestamp}.${rawBody}`;
		let secretBytes;
		try {
			secretBytes = this.decodeSvixSecret(secret);
		} catch {
			throw new BizError('Invalid webhook secret', 401);
		}

		const key = await crypto.subtle.importKey(
			'raw',
			secretBytes,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
		const expectedSignatures = this.parseSignatureHeader(signature);

		for (const item of expectedSignatures) {
			const [version, value] = item;
			if (version !== 'v1' || !value) {
				continue;
			}

			let actual;
			try {
				actual = this.decodeBase64(value);
			} catch {
				throw new BizError('Invalid webhook signature', 401);
			}

			if (secretUtils.timingSafeBytesEqual(digest, actual)) {
				return;
			}
		}

		throw new BizError('Invalid webhook signature', 401);
	},

	parseSignatureHeader(signature) {
		return signature.split(' ')
			.map(part => {
				const commaIndex = part.indexOf(',');
				if (commaIndex > -1) {
					return [part.slice(0, commaIndex), part.slice(commaIndex + 1)];
				}

				const equalIndex = part.indexOf('=');
				if (equalIndex > -1) {
					return [part.slice(0, equalIndex), part.slice(equalIndex + 1)];
				}

				return [];
			})
			.filter(([version, value]) => version && value);
	},

	decodeSvixSecret(secret) {
		const value = secret.startsWith('whsec_') ? secret.slice(6) : secret;
		return this.decodeBase64(value);
	},

	decodeBase64(value) {
		return Uint8Array.from(atob(value), c => c.charCodeAt(0));
	}
}

export default resendService

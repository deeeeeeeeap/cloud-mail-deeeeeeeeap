import { afterEach, describe, expect, it, vi } from 'vitest';
import emailService from '../src/service/email-service';

function params(overrides = {}) {
	return {
		name: 'Sender',
		accountEmail: 'sender@example.com',
		receiveEmail: ['to@example.net'],
		subject: 'Subject',
		text: 'Body',
		html: '<p>Body</p>',
		preparedAttachments: [],
		...overrides
	};
}

function stubFetch(implementation) {
	const fetchMock = vi.fn(implementation);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

describe('Resend REST request', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sends the same payload the SDK produced, with the idempotency key and a user agent', async () => {
		const fetchMock = stubFetch(async () => Response.json({ id: 'resend-1' }));

		const result = await emailService.sendByResend('re_token', params({
			cc: ['cc@example.net'],
			bcc: ['bcc@example.net'],
			replyTo: ['reply@example.net'],
			sendType: 'reply',
			messageId: '<origin@example.net>',
			preparedAttachments: [
				{ content: 'aGk=', filename: 'a.txt', contentType: 'text/plain' },
				{ content: 'iVBO', filename: 'logo.png', contentType: 'image/png', contentId: 'logo' }
			]
		}), 'attempt-key-1');

		expect(result).toEqual({ data: { id: 'resend-1' }, error: null });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.resend.com/emails');
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({
			Authorization: 'Bearer re_token',
			'Content-Type': 'application/json',
			'Idempotency-Key': 'attempt-key-1'
		});
		expect(init.headers['User-Agent']).toBeTruthy();
		expect(JSON.parse(init.body)).toEqual({
			from: 'Sender <sender@example.com>',
			to: ['to@example.net'],
			cc: ['cc@example.net'],
			bcc: ['bcc@example.net'],
			reply_to: ['reply@example.net'],
			subject: 'Subject',
			text: 'Body',
			html: '<p>Body</p>',
			headers: { 'in-reply-to': '<origin@example.net>', references: '<origin@example.net>' },
			attachments: [
				{ content: 'aGk=', filename: 'a.txt', content_type: 'text/plain' },
				{ content: 'iVBO', filename: 'logo.png', content_type: 'image/png', content_id: 'logo' }
			]
		});
	});

	it('omits optional recipients and headers when they are not used', async () => {
		const fetchMock = stubFetch(async () => Response.json({ id: 'resend-2' }));

		await emailService.sendByResend('re_token', params(), 'attempt-key-2');

		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(Object.keys(body).sort()).toEqual(['attachments', 'from', 'html', 'subject', 'text', 'to']);
	});

	it('reports a network failure with a null status code so the outcome stays unknown', async () => {
		stubFetch(async () => {
			throw new TypeError('network down');
		});

		const { data, error } = await emailService.sendByResend('re_token', params(), 'k');

		expect(data).toBeNull();
		expect(error).toMatchObject({ name: 'application_error', statusCode: null });
	});

	it('treats an accepted response with an unreadable body as unknown', async () => {
		stubFetch(async () => new Response('not json', { status: 200 }));

		const { error } = await emailService.sendByResend('re_token', params(), 'k');

		expect(error).toMatchObject({ statusCode: null });
	});

	it('passes the API error body through for explicit rejections', async () => {
		stubFetch(async () => Response.json(
			{ statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' },
			{ status: 422 }
		));

		const { data, error } = await emailService.sendByResend('re_token', params(), 'k');

		expect(data).toBeNull();
		expect(error).toEqual({ statusCode: 422, name: 'validation_error', message: 'Invalid `to` field.' });
	});

	it('keeps the concurrent idempotency error name from the API', async () => {
		stubFetch(async () => Response.json(
			{ statusCode: 409, name: 'concurrent_idempotent_requests', message: 'Same idempotency key in flight' },
			{ status: 409 }
		));

		const { error } = await emailService.sendByResend('re_token', params(), 'k');

		expect(error.name).toBe('concurrent_idempotent_requests');
	});

	it.each([
		[502, '<html>Bad gateway</html>'],
		[403, 'forbidden']
	])('falls back to the HTTP status when a %s error body is not JSON', async (status, text) => {
		stubFetch(async () => new Response(text, { status }));

		const { error } = await emailService.sendByResend('re_token', params(), 'k');

		expect(error).toMatchObject({ name: 'application_error', statusCode: status });
		expect(error.message).toBeTruthy();
	});
});

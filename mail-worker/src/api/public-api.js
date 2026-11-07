import app from '../hono/hono';
import result from '../model/result';
import publicService from '../service/public-service';
import { IdempotentReplay } from '../service/api-idempotency-service';
import { readBoundedSendJson } from '../utils/send-request-utils';
import { readBoundedJson } from '../utils/request-body-utils';

const AUTH_JSON_MAX_BYTES = 32 * 1024;
const PUBLIC_QUERY_JSON_MAX_BYTES = 64 * 1024;
const PUBLIC_IMPORT_JSON_MAX_BYTES = 512 * 1024;

function setRateLimitHeaders(c) {
	const rateLimit = c.get('apiRateLimit');
	if (rateLimit) {
		c.header('X-RateLimit-Limit', String(rateLimit.limit));
		c.header('X-RateLimit-Remaining', String(rateLimit.remaining));
	}
}

app.post('/public/genToken', async (c) => {
	const data = await publicService.genToken(c, await readBoundedJson(
		c,
		AUTH_JSON_MAX_BYTES,
		'authentication JSON body exceeds 32 KiB'
	));
	return c.json(result.ok(data));
});

app.post('/public/emailList', async (c) => {
	const list = await publicService.emailList(c, await readBoundedJson(
		c,
		PUBLIC_QUERY_JSON_MAX_BYTES,
		'public query JSON body exceeds 64 KiB'
	));
	return c.json(result.ok(list));
});

app.post('/public/addUser', async (c) => {
	await publicService.addUser(c, await readBoundedJson(
		c,
		PUBLIC_IMPORT_JSON_MAX_BYTES,
		'public import JSON body exceeds 512 KiB'
	));
	return c.json(result.ok());
});

app.post('/public/sendEmail', async (c) => {
	const params = await readBoundedSendJson(c, 'public send JSON body exceeds 24 MiB');
	try {
		const data = await publicService.sendEmail(c, params);
		setRateLimitHeaders(c);
		return c.json(result.ok(data));
	} catch (e) {
		if (e instanceof IdempotentReplay) {
			c.header('Idempotent-Replayed', 'true');
			if (e.httpStatus >= 400) {
				c.header('X-Cloud-Mail-Error', 'business');
			}
			return c.json(e.body, e.httpStatus);
		}
		throw e;
	}
});

app.get('/public/emailStatus', async (c) => {
	return c.json(result.ok(await publicService.emailStatus(c, c.req.query())));
});

app.post('/public/emailStatus', async (c) => {
	return c.json(result.ok(await publicService.emailStatus(c, await readBoundedJson(
		c,
		PUBLIC_QUERY_JSON_MAX_BYTES,
		'public query JSON body exceeds 64 KiB'
	))));
});

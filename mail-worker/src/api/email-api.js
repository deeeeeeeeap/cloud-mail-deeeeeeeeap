import app from '../hono/hono';
import { inlineAttachmentResponse } from '../service/inline-attachment-service';
import emailService from '../service/email-service';
import result from '../model/result';
import userContext from '../security/user-context';
import attService from '../service/att-service';
import { normalizeSendRequest, readBoundedSendJson } from '../utils/send-request-utils';
import { readBoundedJson } from '../utils/request-body-utils';

const EMAIL_STATE_JSON_MAX_BYTES = 256 * 1024;

app.get('/email/list', async (c) => {
	const data = await emailService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.get('/email/latest', async (c) => {
	const list = await emailService.latest(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(list));
});

app.get('/email/detail', async (c) => {
	const email = await emailService.detail(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(email));
});

app.get('/email/attachment/download', async (c) => {
	return await attService.download(c, c.req.query(), userContext.getUserId(c));
});

app.delete('/email/delete', async (c) => {
	await emailService.delete(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/email/attList', async (c) => {
	const attList = await attService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(attList));
});

app.post('/email/send', async (c) => {
	const params = normalizeSendRequest(await readBoundedSendJson(c));
	const email = await emailService.send(c, params, userContext.getUserId(c));
	return c.json(result.ok(email));
});

app.put('/email/read', async (c) => {
	await emailService.read(c, await readBoundedJson(
		c,
		EMAIL_STATE_JSON_MAX_BYTES,
		'email state JSON body exceeds 256 KiB'
	), userContext.getUserId(c));
	return c.json(result.ok());
})


app.get('/email/attachment/inline', async (c) => {
	return inlineAttachmentResponse(c, c.req.query(), userContext.getUserId(c));
});

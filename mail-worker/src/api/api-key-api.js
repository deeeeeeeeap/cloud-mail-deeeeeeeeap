import app from '../hono/hono';
import result from '../model/result';
import apiKeyService from '../service/api-key-service';
import userContext from '../security/user-context';
import { readBoundedJson } from '../utils/request-body-utils';

const API_KEY_JSON_MAX_BYTES = 32 * 1024;

function readApiKeyJson(c) {
	return readBoundedJson(c, API_KEY_JSON_MAX_BYTES, 'API key JSON body exceeds 32 KiB');
}

app.get('/apiKey/list', async (c) => {
	return c.json(result.ok(await apiKeyService.list(c)));
});

app.post('/apiKey/add', async (c) => {
	const data = await apiKeyService.create(c, await readApiKeyJson(c), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.put('/apiKey/set', async (c) => {
	return c.json(result.ok(await apiKeyService.update(c, await readApiKeyJson(c))));
});

app.post('/apiKey/rotate', async (c) => {
	return c.json(result.ok(await apiKeyService.rotate(c, await readApiKeyJson(c))));
});

app.delete('/apiKey/delete', async (c) => {
	await apiKeyService.remove(c, c.req.query());
	return c.json(result.ok());
});

app.delete('/apiKey/legacyToken', async (c) => {
	await apiKeyService.revokeLegacyToken(c);
	return c.json(result.ok());
});

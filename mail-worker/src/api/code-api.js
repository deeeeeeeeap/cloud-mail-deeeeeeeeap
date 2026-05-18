import app from '../hono/hono';
import result from '../model/result';
import userContext from '../security/user-context';
import codeService from '../service/code-service';

app.get('/code/list', async (c) => {
	const data = await codeService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.get('/code/allList', async (c) => {
	const data = await codeService.allList(c, c.req.query());
	return c.json(result.ok(data));
});

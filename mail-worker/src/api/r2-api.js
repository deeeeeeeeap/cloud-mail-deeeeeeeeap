import r2Service from '../service/r2-service';
import app from '../hono/hono';
import attService from '../service/att-service';

app.get('/oss/*', async (c) => {
	const key = c.req.path.split('/oss/')[1];
	if (await attService.isPubliclyProtectedKey(c, key)) {
		return c.text('Not found', 404);
	}
	const obj = await r2Service.getObj(c, key);
	const response = r2Service.toResponse(obj);
	return response || c.text('Not found', 404);
});



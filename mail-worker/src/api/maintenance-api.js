import app from '../hono/hono';
import result from '../model/result';
import maintenanceService from '../service/maintenance-service';

app.get('/maintenance/health', async (c) => {
	const data = await maintenanceService.health(c);
	return c.json(result.ok(data));
});

app.post('/maintenance/repair', async (c) => {
	const { action } = await c.req.json();
	const data = await maintenanceService.repair(c, action);
	return c.json(result.ok(data));
});

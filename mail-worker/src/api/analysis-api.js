import app from '../hono/hono';
import analysisService from '../service/analysis-service';
import result from '../model/result';

app.get('/analysis/echarts', async (c) => {
	const data = await analysisService.echarts(c, c.req.query());
	return c.json(result.ok(data));
})

app.get('/analysis/d1Health', async (c) => {
	const data = await analysisService.d1Health(c);
	return c.json(result.ok(data));
})

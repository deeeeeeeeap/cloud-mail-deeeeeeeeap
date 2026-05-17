import resendService from '../service/resend-service';
import app from '../hono/hono';
app.post('/webhooks',async (c) => {
	try {
		await resendService.webhooks(c, await c.req.text());
		return c.text('success', 200)
	} catch (e) {
		return c.text(e.message, e.code || 500)
	}
})

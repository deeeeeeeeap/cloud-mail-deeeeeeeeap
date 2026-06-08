import app from '../hono/hono';
import telegramService from '../service/telegram-service';

app.get('/telegram/getEmail/:token', async (c) => {
	const content = await telegramService.getEmailContent(c, c.req.param());
	c.header('Cache-Control', 'private, max-age=0, no-store');
	c.header('X-Robots-Tag', 'noindex, nofollow');
	return c.html(content)
});


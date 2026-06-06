import { describe, expect, it } from 'vitest';
import emailHtmlTemplate from '../src/template/email-html';
import emailTextTemplate from '../src/template/email-text';

describe('telegram email templates', () => {
	it('sanitizes active HTML before embedding it in the telegram web app view', () => {
		const html = emailHtmlTemplate(`
			<body style="color:red; background:url(javascript:alert(1));">
				<img src="javascript:alert(1)" onerror="alert(1)">
				<a href="javascript:alert(1)">open</a>
				<style>@import url(https://attacker.example/style.css)</style>
				<script>alert(1)</script>
				</script><script>globalThis.__xss = true</script>
				<p>{{domain}}asset.png</p>
			</body>
		`, 'https://assets.example.com');

		expect(html).not.toMatch(/onerror/i);
		expect(html).not.toMatch(/javascript:/i);
		expect(html).not.toMatch(/@import/i);
		expect(html).not.toContain('globalThis.__xss');
		expect(html).not.toContain('</script><script>');
		expect(html).toContain('https://assets.example.com/asset.png');
	});

	it('escapes text email content', () => {
		const html = emailTextTemplate('<img src=x onerror=alert(1)>');

		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(html).not.toContain('<img src=x onerror=alert(1)>');
	});
});

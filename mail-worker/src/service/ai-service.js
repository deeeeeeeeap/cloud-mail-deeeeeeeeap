import emailUtils from '../utils/email-utils';
import { settingConst } from '../const/entity-const';

const CODE_HINT_RE = /(verification|verify|one[-\s]?time|otp|passcode|security|auth(?:entication)?|login|sign[-\s]?in|sign[-\s]?up|signup|code|pin|验证码|校验码|动态码|安全码|确认码|登录码|注册|一次性|口令|密码)/i;
const CODE_TOKEN_RE = /(^|[^A-Za-z0-9])([A-Za-z0-9]{4,8})(?=$|[^A-Za-z0-9])/g;
const SEPARATED_DIGIT_CODE_RE = /(^|[^A-Za-z0-9])(\d(?:[ \t-]?\d){3,7})(?=$|[^A-Za-z0-9])/g;

function normalizeCodeToken(token) {
	const code = String(token || '').replace(/[\s-]/g, '').toUpperCase();
	if (code.length < 4 || code.length > 8) {
		return '';
	}
	if (!/\d/.test(code) || !/^[A-Z0-9]+$/.test(code)) {
		return '';
	}
	if (/^[A-Z]+$/.test(code)) {
		return '';
	}
	return code;
}

function collectHintPositions(text) {
	const positions = [];
	const hintRe = new RegExp(CODE_HINT_RE.source, 'ig');
	let match;
	while ((match = hintRe.exec(text)) !== null) {
		positions.push(match.index);
	}
	return positions;
}

function collectCodeCandidates(text) {
	const candidates = [];
	for (const tokenRe of [SEPARATED_DIGIT_CODE_RE, CODE_TOKEN_RE]) {
		tokenRe.lastIndex = 0;
		let match;
		while ((match = tokenRe.exec(text)) !== null) {
			const raw = match[2];
			const code = normalizeCodeToken(raw);
			if (code) {
				candidates.push({
					code,
					raw,
					index: match.index + match[1].length
				});
			}
		}
	}
	return candidates;
}

function lineAround(text, index) {
	const start = Math.max(text.lastIndexOf('\n', index - 1) + 1, 0);
	const endIndex = text.indexOf('\n', index);
	const end = endIndex === -1 ? text.length : endIndex;
	return text.slice(start, end).trim();
}

function scoreCandidate(text, candidate, hintPositions, subjectLength) {
	const code = candidate.code;
	let score = 0;

	if (/^\d+$/.test(code)) {
		score += 20;
	}
	if (code.length === 6) {
		score += 20;
	} else if (code.length === 4 || code.length === 5 || code.length === 8) {
		score += 8;
	}

	const line = lineAround(text, candidate.index);
	if (normalizeCodeToken(line) === code) {
		score += 70;
	}

	const nearestHintDistance = hintPositions.reduce((best, hintIndex) => {
		return Math.min(best, Math.abs(candidate.index - hintIndex));
	}, Number.POSITIVE_INFINITY);
	if (nearestHintDistance !== Number.POSITIVE_INFINITY) {
		score += Math.max(0, 130 - nearestHintDistance);
	}

	if (subjectLength > 0 && candidate.index > subjectLength && candidate.index < subjectLength + 800) {
		score += 20;
	}

	const number = Number(code);
	if (/^\d{4}$/.test(code) && number >= 1900 && number <= 2099 && nearestHintDistance > 40) {
		score -= 60;
	}

	return score;
}

export function extractCodeByPattern(email) {
	const subject = emailUtils.formatText(email?.subject || '');
	const text = emailUtils.formatText(email?.text || '');
	const htmlText = emailUtils.htmlToText(email?.html || '');
	const body = [text, htmlText].filter(Boolean).join('\n');
	const content = [subject, body].filter(Boolean).join('\n');

	if (!content || !CODE_HINT_RE.test(content)) {
		return '';
	}

	const candidates = collectCodeCandidates(content);
	if (candidates.length === 0) {
		return '';
	}

	const hintPositions = collectHintPositions(content);
	const subjectLength = subject.length;
	const [best] = candidates
		.map(candidate => ({
			...candidate,
			score: scoreCandidate(content, candidate, hintPositions, subjectLength)
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index);

	return best && best.score > 0 ? best.code : '';
}

const aiService = {
	extractCodeByPattern,

	async extractCode(c, email, options = {}) {
		if (!this.shouldExtractCode(options.aiCode, options.aiCodeFilter, email)) {
			return '';
		}

		const patternCode = extractCodeByPattern(email);
		if (patternCode) {
			return patternCode;
		}

		const ai = c.env.ai;
		if (!ai?.run) {
			return '';
		}

		try {
			const subject = email.subject || '';
			const text = emailUtils.formatText(email.text || '');
			const htmlText = emailUtils.htmlToText(email.html || '');
			const body = (htmlText || text).slice(0, 6000);

			if (!subject && !body) {
				return '';
			}

			const result = await ai.run(c.env.ai_model || '@cf/meta/llama-3.1-8b-instruct', {
				messages: [
					{
						role: 'system',
						content: 'You extract verification codes from emails. Return only JSON like {"code":"12345678"} or {"code":""}. The code must be 8 characters or fewer and must not contain spaces. If the code is longer than 8 characters or contains spaces, return {"code":""}. Do not explain.'
					},
					{
						role: 'user',
						content: `Subject: ${subject}\n\n${body}`
					}
				],
				temperature: 0,
				max_tokens: 32
			});

			const content = typeof result === 'string' ? result : result?.response || '';
			const json = JSON.parse(content);
			if (typeof json.code !== 'string') {
				return '';
			}

			if (json.code.length > 8 || /\s/.test(json.code)) {
				return '';
			}

			return json.code;
		} catch (e) {
			console.error('验证码提取失败: ', e);
			return '';
		}
	},

	shouldExtractCode(aiCode, aiCodeFilterStr, email) {
		if (aiCode !== settingConst.aiCode.OPEN) {
			return false;
		}

		const filterList = aiCodeFilterStr ? aiCodeFilterStr.split(',').map(item => item.trim().toLowerCase()).filter(Boolean) : [];

		if (filterList.length === 0) {
			return true;
		}

		const fromEmail = (email.from?.address || '').trim().toLowerCase();
		const fromDomain = emailUtils.getDomain(fromEmail).toLowerCase();

		return filterList.some(item => item === fromEmail || item === fromDomain);
	}
};

export default aiService;

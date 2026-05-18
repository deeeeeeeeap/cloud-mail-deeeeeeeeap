import emailUtils from '../utils/email-utils';
import { settingConst } from '../const/entity-const';

const CONTENT_LIMIT = 8000;
const QUICK_HTML_LIMIT = 12000;
const SCORE_THRESHOLD = 85;

const AUTH_PURPOSE_RE = /(verification|verify|one[-\s]?time|otp|2fa|mfa|passcode|security\s+code|auth(?:entication)?\s+code|login\s+code|log[-\s]?in\s+code|sign[-\s]?in\s+code|sign[-\s]?up\s+code|signup\s+code|confirm(?:ation)?\s+code|\u9a8c\u8bc1\u7801|\u6821\u9a8c\u7801|\u52a8\u6001\u7801|\u5b89\u5168\u7801|\u786e\u8ba4\u7801|\u767b\u5f55\u7801|\u6ce8\u518c\u7801|\u4e00\u6b21\u6027|\u53e3\u4ee4)/i;
const WEAK_AUTH_RE = /(login|log[-\s]?in|sign[-\s]?in|sign[-\s]?up|signup|register|registration|auth(?:entication)?|security|password|account|\u767b\u5f55|\u6ce8\u518c|\u8d26\u53f7|\u8d26\u6237|\u5bc6\u7801|\u5b89\u5168)/i;
const GENERIC_CODE_LABEL_RE = /(\bcode\b|\bpin\b|\u9a8c\u8bc1\u7801|\u6821\u9a8c\u7801|\u52a8\u6001\u7801|\u5b89\u5168\u7801|\u786e\u8ba4\u7801|\u767b\u5f55\u7801|\u6ce8\u518c\u7801|\u53e3\u4ee4|\u5bc6\u7801)/i;
const STRONG_CODE_LABEL_RE = /(verification\s+code|verify\s+code|one[-\s]?time\s+code|otp|2fa|mfa|passcode|security\s+code|auth(?:entication)?\s+code|login\s+code|log[-\s]?in\s+code|sign[-\s]?in\s+code|sign[-\s]?up\s+code|signup\s+code|confirm(?:ation)?\s+code|\u9a8c\u8bc1\u7801|\u6821\u9a8c\u7801|\u52a8\u6001\u7801|\u5b89\u5168\u7801|\u786e\u8ba4\u7801|\u767b\u5f55\u7801|\u6ce8\u518c\u7801|\u53e3\u4ee4)/i;
const DIRECT_CODE_LABEL_RE = /(verification\s+code|verify\s+code|one[-\s]?time\s+code|otp|2fa|mfa|passcode|security\s+code|auth(?:entication)?\s+code|login\s+code|log[-\s]?in\s+code|sign[-\s]?in\s+code|sign[-\s]?up\s+code|signup\s+code|confirm(?:ation)?\s+code|\bcode\b|\bpin\b|\u9a8c\u8bc1\u7801|\u6821\u9a8c\u7801|\u52a8\u6001\u7801|\u5b89\u5168\u7801|\u786e\u8ba4\u7801|\u767b\u5f55\u7801|\u6ce8\u518c\u7801|\u53e3\u4ee4|\u5bc6\u7801)/i;
const ACTION_RE = /(\buse\b|\benter\b|\binput\b|\btype\b|\bcopy\b|\bpaste\b|\bsubmit\b|\bconfirm\b|\bverify\b|\bauthenticate\b|\bcontinue\b|\bcomplete\b|\u8f93\u5165|\u586b\u5199|\u4f7f\u7528|\u590d\u5236|\u7c98\u8d34|\u9a8c\u8bc1|\u786e\u8ba4|\u767b\u5f55|\u7ee7\u7eed)/i;
const NEGATIVE_CONTEXT_RE = /(invoice|receipt|order|tracking|shipment|package|delivery|reference|ref(?:erence)?\s*id|ticket|case|request|transaction|payment|amount|total|balance|promo|coupon|discount|voucher|referral|gift\s*card|status\s*code|error\s*code|source\s*code|zip\s*code|postal\s*code|ip(?:\s*address)?|browser|device|version|chrome|firefox|edge|safari|windows|macos|android|ios|copyright|unsubscribe|\u8ba2\u5355|\u53d1\u7968|\u7269\u6d41|\u5feb\u9012|\u7f16\u53f7|\u53c2\u8003|\u4f18\u60e0|\u6298\u6263|\u8bbe\u5907|\u6d4f\u89c8\u5668)/i;
const URL_OR_EMAIL_RE = /(?:https?:\/\/|www\.)\S+|\b\S+@\S+\b/i;
const CODE_TOKEN_RE = /(^|[^A-Za-z0-9])([A-Za-z0-9]{4,8})(?=$|[^A-Za-z0-9])/g;
const SEPARATED_DIGIT_CODE_RE = /(^|[^A-Za-z0-9])(\d(?:[ \t-]?\d){3,7})(?=$|[^A-Za-z0-9])/g;

function regexPositions(regex, text) {
	const positions = [];
	const re = new RegExp(regex.source, 'ig');
	let match;
	while ((match = re.exec(text)) !== null) {
		positions.push(match.index);
	}
	return positions;
}

function hasExtractionSignal(text) {
	if (!text) {
		return false;
	}
	return AUTH_PURPOSE_RE.test(text) || (WEAK_AUTH_RE.test(text) && GENERIC_CODE_LABEL_RE.test(text));
}

function quickHtmlText(html) {
	if (!html) {
		return '';
	}
	return String(html)
		.slice(0, QUICK_HTML_LIMIT)
		.replace(/<[^>]*>/g, ' ')
		.replace(/&(?:nbsp|amp|lt|gt|quot|apos|#\d+);/gi, ' ');
}

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
	if (/^(.)\1+$/.test(code)) {
		return '';
	}
	return code;
}

function collectHintPositions(text) {
	return [
		...regexPositions(AUTH_PURPOSE_RE, text),
		...regexPositions(DIRECT_CODE_LABEL_RE, text)
	].sort((a, b) => a - b);
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

function windowAround(text, index, radius = 100) {
	return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

function nearestDistance(positions, index) {
	return positions.reduce((best, hintIndex) => {
		return Math.min(best, Math.abs(index - hintIndex));
	}, Number.POSITIVE_INFINITY);
}

function looksLikeDateOrVersion(code, line) {
	if (/^\d{4}$/.test(code)) {
		const year = Number(code);
		if (year >= 1900 && year <= 2099) {
			return true;
		}
	}

	if (/^\d{8}$/.test(code)) {
		const year = Number(code.slice(0, 4));
		const month = Number(code.slice(4, 6));
		const day = Number(code.slice(6, 8));
		if (year >= 1900 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			return true;
		}
	}

	return /\b\d{1,4}(?:[.-]\d{1,4}){1,3}\b/.test(line) && /(date|time|version|chrome|firefox|edge|safari|ip|\u65e5\u671f|\u65f6\u95f4|\u7248\u672c)/i.test(line);
}

function scoreCandidate(text, candidate, hintPositions, subjectLength) {
	const code = candidate.code;
	const line = lineAround(text, candidate.index);
	const context = windowAround(text, candidate.index);
	const subject = text.slice(0, subjectLength);
	const subjectHasAuthPurpose = AUTH_PURPOSE_RE.test(subject);
	const strongLabelNear = STRONG_CODE_LABEL_RE.test(context);
	const directLabelNear = DIRECT_CODE_LABEL_RE.test(context);
	const authPurposeNear = AUTH_PURPOSE_RE.test(context);
	const actionNear = ACTION_RE.test(context);
	const negativeContext = NEGATIVE_CONTEXT_RE.test(line) || URL_OR_EMAIL_RE.test(line);
	const nearestHintDistance = nearestDistance(hintPositions, candidate.index);
	let score = 0;

	if (/^\d+$/.test(code)) {
		score += 8;
	} else {
		score += 16;
	}
	if (code.length === 6) {
		score += 14;
	} else if (code.length === 4 || code.length === 5 || code.length === 8) {
		score += 6;
	}

	if (strongLabelNear) {
		score += 90;
	} else if (directLabelNear && (actionNear || authPurposeNear || subjectHasAuthPurpose)) {
		score += 70;
	} else if (directLabelNear) {
		score += 25;
	}
	if (authPurposeNear) {
		score += 35;
	}
	if (actionNear) {
		score += 20;
	}
	if (subjectHasAuthPurpose && candidate.index > subjectLength && candidate.index < subjectLength + 1000) {
		score += 50;
	}
	if (normalizeCodeToken(line) === code && (subjectHasAuthPurpose || authPurposeNear || directLabelNear)) {
		score += 70;
	}
	if (nearestHintDistance !== Number.POSITIVE_INFINITY) {
		score += Math.max(0, 40 - nearestHintDistance);
	}

	if (!directLabelNear && !authPurposeNear && !subjectHasAuthPurpose) {
		score -= 80;
	}
	if (negativeContext) {
		score -= 150;
	}
	if (looksLikeDateOrVersion(code, line)) {
		score -= 120;
	}

	return score;
}

export function extractCodeByPattern(email) {
	const subject = emailUtils.formatText(email?.subject || '');
	const text = emailUtils.formatText(email?.text || '');
	const rawHtml = email?.html || '';
	const rawHtmlText = quickHtmlText(rawHtml);
	const quickContent = [subject, text, rawHtmlText].filter(Boolean).join('\n').slice(0, CONTENT_LIMIT);

	if (!hasExtractionSignal(quickContent)) {
		return '';
	}

	const htmlText = rawHtml && (!text || hasExtractionSignal(rawHtmlText))
		? emailUtils.htmlToText(rawHtml)
		: '';
	const body = [text, htmlText].filter(Boolean).join('\n');
	const content = [subject, body].filter(Boolean).join('\n').slice(0, CONTENT_LIMIT);

	if (!content || !hasExtractionSignal(content)) {
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

	return best && best.score >= SCORE_THRESHOLD ? best.code : '';
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

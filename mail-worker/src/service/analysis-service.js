import analysisDao from '../dao/analysis-dao';
import orm from '../entity/orm';
import email from '../entity/email';
import { desc, count, eq, and, ne, isNotNull } from 'drizzle-orm';
import { emailConst } from '../const/entity-const';
import kvConst from '../const/kv-const';
import dayjs from 'dayjs';
import { toUtc } from '../utils/date-uitil';

// 沿用既有快照有效期；命中不续期，过期后由下次访问重新聚合。
const ANALYSIS_ECHARTS_TTL_SECONDS = 35 * 60;

// 同一时区的不同写法共用快照；无法识别的值回退 UTC。
function normalizeTimeZone(timeZone) {
	const candidate = typeof timeZone === 'string' ? timeZone.trim() : '';
	if (!candidate) {
		return 'UTC';
	}
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
	} catch (e) {
		return 'UTC';
	}
}

const analysisService = {

	async echarts(c, params) {
		// 走缓存时时区由 echartsCacheKey 归一，这里补上不走缓存的分支，
		// 避免同一个请求因 analysis_cache 开关不同而一边正常返回、一边抛时区解析异常
		const timeZone = normalizeTimeZone(params?.timeZone);
		params = { ...params, timeZone };

		if (!this.analysisCacheEnabled(c)) {
			return await this.queryEcharts(c, params);
		}

		const cacheKey = this.echartsCacheKey(params);
		const cache = await c.env.kv.get(cacheKey, { type: 'json' });

		if (cache) {
			return cache;
		}

		const data = await this.queryEcharts(c, params);
		await c.env.kv.put(cacheKey, JSON.stringify(data), { expirationTtl: ANALYSIS_ECHARTS_TTL_SECONDS });
		return data;
	},

	async queryEcharts(c, params) {

		const { timeZone } = params;

		let utcDate = toUtc().startOf('day');

		let localDate = utcDate.tz(timeZone);

		utcDate = dayjs(utcDate.format('YYYY-MM-DD HH:mm:ss'))

		localDate = dayjs(localDate.format('YYYY-MM-DD HH:mm:ss'))

		//获取时差
		const diffHours = localDate.diff(utcDate, 'hour',true);


		const [
			numberCount,
			nameRatio,
			userDayCountRaw,
			receiveDayCountRaw,
			sendDayCountRaw,
			daySendTotal
		] = await Promise.all([
			analysisDao.numberCount(c),

			this.nameRatio(c),


			analysisDao.userDayCount(c, diffHours),
			analysisDao.receiveDayCount(c, diffHours),
			analysisDao.sendDayCount(c, diffHours),

			analysisDao.daySendTotal(c),
		]);


		const userDayCount = this.filterEmptyDay(userDayCountRaw, timeZone);
		const receiveDayCount = this.filterEmptyDay(receiveDayCountRaw, timeZone);
		const sendDayCount = this.filterEmptyDay(sendDayCountRaw, timeZone);

		return {
			numberCount,
			userDayCount,
			receiveRatio: {
				nameRatio
			},
			emailDayCount: {
				receiveDayCount,
				sendDayCount
			},
			daySendTotal: Number(daySendTotal)
		};
	},

	async nameRatio(c) {
		return orm(c)
			.select({ name: email.name, total: count() })
			.from(email)
			.where(and(eq(email.type, emailConst.type.RECEIVE), isNotNull(email.name), ne(email.name, 'noreply'), ne(email.name, '')))
			.groupBy(email.name)
			.orderBy(desc(count()))
			.limit(6);
	},

	async d1Health(c) {
		const start = Date.now();
		const [emailCount, indexRows, queryPlan] = await Promise.all([
			c.env.db.prepare(`SELECT COUNT(*) AS total FROM email`).first(),
			c.env.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all(),
			c.env.db.prepare(`
				EXPLAIN QUERY PLAN
				SELECT email_id
				FROM email
				WHERE user_id = ? AND account_id = ? AND type = ? AND is_del = ?
				ORDER BY email_id DESC
				LIMIT 50
			`).bind(0, 0, emailConst.type.RECEIVE, 0).all()
		]);

		const durationMs = Date.now() - start;
		const indexes = (indexRows.results || []).map(row => row.name);
		const expectedIndexes = [
			'idx_email_user_account_type_del_id',
			'idx_email_user_type_del_id',
			'idx_email_type_status_id',
			'idx_attachments_email_type',
			'idx_star_user_email'
		];
		const missingIndexes = expectedIndexes.filter(name => !indexes.includes(name));
		const queryPlanText = (queryPlan.results || []).map(row => row.detail || '').join(' | ');

		return {
			ok: missingIndexes.length === 0,
			durationMs,
			slow: durationMs > 200,
			emailTotal: emailCount.total,
			missingIndexes,
			queryPlan: queryPlanText,
			usesIndex: /USING .*INDEX/i.test(queryPlanText)
		};
	},

	filterEmptyDay(data, timeZone) {
		const today = toUtc().tz(timeZone).subtract(1, 'day');
		const previousDays = Array.from({ length: 15 }, (_, i) => {
			return today.subtract(i, 'day').format('YYYY-MM-DD');
		}).reverse();

		return  previousDays.map(day => {
			const index = data.findIndex(item => item.date === day)
			const total = index > - 1 ? data[index].total : 0
			return {date: day,total}
		})

	},

	echartsCacheKey(params = {}) {
		return kvConst.ANALYSIS_ECHARTS + encodeURIComponent(normalizeTimeZone(params.timeZone));
	},

	analysisCacheEnabled(c) {
		return c.env.analysis_cache === true || c.env.analysis_cache === 'true';
	}
}

export default  analysisService

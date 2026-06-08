import analysisDao from '../dao/analysis-dao';
import orm from '../entity/orm';
import email from '../entity/email';
import { desc, count, eq, and, ne, isNotNull } from 'drizzle-orm';
import { emailConst } from '../const/entity-const';
import kvConst from '../const/kv-const';
import dayjs from 'dayjs';
import { toUtc } from '../utils/date-uitil';

const ANALYSIS_REFRESH_CONCURRENCY = 3;

const analysisService = {

	async echarts(c, params) {
		if (!this.analysisCacheEnabled(c)) {
			return await this.queryEcharts(c, params);
		}

		const cacheKey = this.echartsCacheKey(params);
		const cache = await c.env.kv.get(cacheKey, { type: 'json' });

		if (cache) {
			return cache;
		}

		return await this.refreshEchartsCacheByKey(c, cacheKey);
	},

	async refreshEchartsCacheByKey(c, cacheKey, options = {}) {
		const params = this.echartsParamsByCacheKey(cacheKey);
		const data = await this.queryEcharts(c, params, options);
		await c.env.kv.put(cacheKey, JSON.stringify(data));
		return data;
	},

	async refreshEchartsCache(c) {
		if (!this.analysisCacheEnabled(c)) {
			return;
		}

		const numberCount = await this.refreshNumberCountCache(c);
		let cursor;

		do {
			const page = await c.env.kv.list({ prefix: kvConst.ANALYSIS_ECHARTS, cursor });
			const keys = page.keys || [];

			await this.mapLimit(keys, ANALYSIS_REFRESH_CONCURRENCY, async key => {
				try {
					await this.refreshEchartsCacheByKey(c, key.name, { numberCount });
				} catch (e) {
					console.error(`Refresh analysis cache failed for ${key.name}:`, e?.message || e);
				}
			});

			if (page.list_complete || !page.cursor) {
				break;
			}
			cursor = page.cursor;
		} while (cursor);
	},

	async queryEcharts(c, params, options = {}) {

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
			daySendTotalRaw
		] = await Promise.all([
			options.numberCount ?? this.numberCount(c),

			orm(c)
				.select({ name: email.name, total: count() })
				.from(email)
				.where(and(eq(email.type, emailConst.type.RECEIVE), isNotNull(email.name),ne(email.name,'noreply'), ne(email.name,'')))
				.groupBy(email.name)
				.orderBy(desc(count()))
				.limit(6),


			analysisDao.userDayCount(c, diffHours),
			analysisDao.receiveDayCount(c, diffHours),
			analysisDao.sendDayCount(c, diffHours),

			c.env.kv.get(kvConst.SEND_DAY_COUNT + dayjs().format('YYYY-MM-DD')),
		]);


		const userDayCount = this.filterEmptyDay(userDayCountRaw, timeZone);
		const receiveDayCount = this.filterEmptyDay(receiveDayCountRaw, timeZone);
		const sendDayCount = this.filterEmptyDay(sendDayCountRaw, timeZone);

		const daySendTotal = daySendTotalRaw || 0;

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

	async numberCount(c) {
		if (!this.analysisCacheEnabled(c)) {
			return analysisDao.numberCount(c);
		}

		const cache = await c.env.kv.get(kvConst.ANALYSIS_NUMBER_COUNT, { type: 'json' });
		if (cache) {
			return cache;
		}

		const data = await analysisDao.numberCount(c);
		await c.env.kv.put(kvConst.ANALYSIS_NUMBER_COUNT, JSON.stringify(data), { expirationTtl: 60 });
		return data;
	},

	async refreshNumberCountCache(c) {
		const data = await analysisDao.numberCount(c);

		if (this.analysisCacheEnabled(c)) {
			await c.env.kv.put(kvConst.ANALYSIS_NUMBER_COUNT, JSON.stringify(data), { expirationTtl: 60 });
		}

		return data;
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
		return kvConst.ANALYSIS_ECHARTS + encodeURIComponent(params.timeZone || 'UTC');
	},

	echartsParamsByCacheKey(cacheKey) {
		return {
			timeZone: decodeURIComponent(cacheKey.replace(kvConst.ANALYSIS_ECHARTS, ''))
		};
	},

	analysisCacheEnabled(c) {
		return c.env.analysis_cache === true || c.env.analysis_cache === 'true';
	},

	async mapLimit(items, limit, mapper) {
		let index = 0;
		const workerCount = Math.min(limit, items.length);
		const workers = Array.from({ length: workerCount }, async () => {
			while (index < items.length) {
				const item = items[index++];
				await mapper(item);
			}
		});

		await Promise.all(workers);
	}
}

export default  analysisService

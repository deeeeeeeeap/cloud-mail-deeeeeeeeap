import { emailConst } from '../const/entity-const';

// SQLite 日期修饰符要求数字自带符号，例如 '+5.5 hours' / '-8 hours'
function offsetModifier(diffHours) {
	const hours = Number(diffHours) || 0;
	return `${hours >= 0 ? '+' : ''}${hours} hours`;
}

function dayRangeBinds(diffHours) {
	const offset = offsetModifier(diffHours);
	const inverse = offsetModifier(-(Number(diffHours) || 0));
	return { offset, inverse };
}

const analysisDao = {
	async numberCount(c) {
		const { results } = await c.env.db.prepare(`
            SELECT
				COALESCE(e.receiveTotal, 0) AS receiveTotal,
				COALESCE(e.sendTotal, 0) AS sendTotal,
				COALESCE(e.delReceiveTotal, 0) AS delReceiveTotal,
				COALESCE(e.delSendTotal, 0) AS delSendTotal,
				COALESCE(e.normalReceiveTotal, 0) AS normalReceiveTotal,
				COALESCE(e.normalSendTotal, 0) AS normalSendTotal,
				COALESCE(u.userTotal, 0) AS userTotal,
				COALESCE(u.normalUserTotal, 0) AS normalUserTotal,
				COALESCE(u.delUserTotal, 0) AS delUserTotal,
				COALESCE(a.accountTotal, 0) AS accountTotal,
				COALESCE(a.normalAccountTotal, 0) AS normalAccountTotal,
				COALESCE(a.delAccountTotal, 0) AS delAccountTotal
            FROM
                (
                    SELECT
                        SUM(CASE WHEN type = 0 THEN 1 ELSE 0 END) AS receiveTotal,
                        SUM(CASE WHEN type = 1 THEN 1 ELSE 0 END) AS sendTotal,
                        SUM(CASE WHEN type = 0 AND is_del = 1 THEN 1 ELSE 0 END) AS delReceiveTotal,
                        SUM(CASE WHEN type = 1 AND is_del = 1 THEN 1 ELSE 0 END) AS delSendTotal,
                        SUM(CASE WHEN type = 0 AND is_del = 0 THEN 1 ELSE 0 END) AS normalReceiveTotal,
                        SUM(CASE WHEN type = 1 AND is_del = 0 THEN 1 ELSE 0 END) AS normalSendTotal
                    FROM
                        email where status != ${emailConst.status.SAVING}
                ) e
            CROSS JOIN (
                SELECT
                    COUNT(*) AS userTotal,
                    SUM(CASE WHEN is_del = 1 THEN 1 ELSE 0 END) AS delUserTotal,
                    SUM(CASE WHEN is_del = 0 THEN 1 ELSE 0 END) AS normalUserTotal
                FROM
                    user
            ) u
            CROSS JOIN (
                SELECT
                    COUNT(*) AS accountTotal,
                    SUM(CASE WHEN is_del = 1 THEN 1 ELSE 0 END) AS delAccountTotal,
                    SUM(CASE WHEN is_del = 0 THEN 1 ELSE 0 END) AS normalAccountTotal
                FROM
                    account
            ) a
        `).all();
		return results[0];
	},

	//谓词使用裸列范围(create_time >= ? AND create_time < ?)以命中索引，DATE() 仅用于分组
	async userDayCount(c, diffHours) {
		const { offset, inverse } = dayRangeBinds(diffHours);
		const { results } = await c.env.db.prepare(`
            SELECT
                DATE(create_time, ?1) AS date,
                COUNT(*) AS total
            FROM
                user
            WHERE
                create_time >= DATETIME(DATE('now', '-15 days', ?1), ?2)
                AND create_time < DATETIME(DATE('now', ?1), ?2)
            GROUP BY
                DATE(create_time, ?1)
            ORDER BY
                date ASC
        `).bind(offset, inverse).all();
		return results;
	},

	async receiveDayCount(c, diffHours) {
		return this.emailDayCount(c, diffHours, emailConst.type.RECEIVE);
	},

	async sendDayCount(c, diffHours) {
		return this.emailDayCount(c, diffHours, emailConst.type.SEND);
	},

	async emailDayCount(c, diffHours, type) {
		const { offset, inverse } = dayRangeBinds(diffHours);
		const { results } = await c.env.db.prepare(`
            SELECT
                DATE(create_time, ?1) AS date,
                COUNT(*) AS total
            FROM
                email
            WHERE
                type = ?3
                AND create_time >= DATETIME(DATE('now', '-15 days', ?1), ?2)
                AND create_time < DATETIME(DATE('now', ?1), ?2)
            GROUP BY
                DATE(create_time, ?1)
            ORDER BY
                date ASC
        `).bind(offset, inverse, type).all();
		return results;
	}

};

export default analysisDao;

import BizError from '../error/biz-error';
import { isConfiguredDomain } from '../utils/domain-utils';
import accountService from './account-service';
import orm from '../entity/orm';
import user from '../entity/user';
import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { emailConst, isDel, roleConst, userConst } from '../const/entity-const';
import kvConst from '../const/kv-const';
import KvConst from '../const/kv-const';
import authInfoCache from '../security/auth-info-cache';
import userContext from '../security/user-context';
import cryptoUtils from '../utils/crypto-utils';
import emailService from './email-service';
import dayjs from 'dayjs';
import roleService from './role-service';
import emailUtils from '../utils/email-utils';
import saltHashUtils from '../utils/crypto-utils';
import constant from '../const/constant';
import { t } from '../i18n/i18n'
import reqUtils from '../utils/req-utils';
import {oauth} from "../entity/oauth";
import oauthService from "./oauth-service";
import { chunkArray, truncateLikeTerm } from '../utils/sql-utils';
import { selectLoginUserContext } from './login-user-info-query';

function assertValidNewPassword(password) {
	if (typeof password !== 'string' || password.length < 6) {
		throw new BizError(t('pwdMinLength'));
	}
	if (password.length > 30) {
		throw new BizError(t('pwdLengthLimit'));
	}
}

async function replacePassword(c, password, userId) {
	assertValidNewPassword(password);
	const { salt, hash } = await cryptoUtils.hashPassword(password);
	await orm(c).update(user).set({ password: hash, salt }).where(eq(user.userId, userId)).run();
}

const userService = {

	async loginUserInfo(c, userId) {

		const { userRow, account, roleRow, permKeys: queriedPermKeys } =
			await selectLoginUserContext(c, userId);

		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}

		const isAdmin = emailUtils.isSameAddress(userRow.email, c.env.admin);
		const permKeys = isAdmin ? ['*'] : queriedPermKeys;

		const user = {};
		user.userId = userRow.userId;
		user.sendCount = userRow.sendCount;
		user.email = userRow.email;
		user.account = account;
		user.name = account.name;
		user.permKeys = permKeys;
		user.role = roleRow;
		user.type = userRow.type;

		if (isAdmin) {
			user.role = constant.ADMIN_ROLE
			user.type = 0;
		}

		return user;
	},


	async resetPassword(c, params, userId) {
		if (!params || typeof params !== 'object' || Array.isArray(params)) {
			throw new BizError(t('IncorrectPwd'), 400);
		}
		const { currentPassword, newPassword } = params;
		if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
			throw new BizError(t('IncorrectPwd'), 400);
		}
		assertValidNewPassword(newPassword);

		const userRow = await this.selectById(c, userId);
		if (!userRow
			|| !await cryptoUtils.verifyPassword(currentPassword, userRow.salt, userRow.password)) {
			throw new BizError(t('IncorrectPwd'), 400);
		}

		const nextPassword = await cryptoUtils.hashPassword(newPassword);
		const updated = await this.compareAndSetPasswordHash(
			c,
			userId,
			nextPassword,
			{ hash: userRow.password, salt: userRow.salt }
		);
		if (!updated) {
			throw new BizError(t('IncorrectPwd'), 409);
		}

		try {
			await authInfoCache.remove(c, userId);
		} catch (e) {
			let rolledBack = false;
			try {
				rolledBack = await this.compareAndSetPasswordHash(
					c,
					userId,
					{ hash: userRow.password, salt: userRow.salt },
					nextPassword
				);
			} catch (rollbackError) {
				console.error('Password reset rollback failed after session revocation error');
			}
			if (!rolledBack) {
				console.error('Password reset could not restore the previous password after session revocation error');
			}
			throw new BizError('Unable to revoke existing sessions', 503);
		}
	},

	async compareAndSetPasswordHash(c, userId, { hash, salt }, expected) {
		const result = await c.env.db.prepare(`
			UPDATE user
			SET password = ?, salt = ?
			WHERE user_id = ?
			  AND password = ?
			  AND salt = ?
		`).bind(hash, salt, userId, expected.hash, expected.salt).run();
		return Number(result?.meta?.changes || 0) === 1;
	},

	async upgradePasswordHash(c, userRow, password) {
		if (!cryptoUtils.needsPasswordUpgrade(userRow.password)) {
			return userRow;
		}

		const upgradedPassword = await cryptoUtils.hashPassword(password);
		const updated = await this.compareAndSetPasswordHash(
			c,
			userRow.userId,
			upgradedPassword,
			{ hash: userRow.password, salt: userRow.salt }
		);
		if (updated) {
			return {
				...userRow,
				password: upgradedPassword.hash,
				salt: upgradedPassword.salt
			};
		}

		const currentUserRow = await this.selectByIdIncludeDel(c, userRow.userId);
		if (currentUserRow
			&& await cryptoUtils.verifyPassword(password, currentUserRow.salt, currentUserRow.password)) {
			return currentUserRow;
		}
		return null;
	},

	selectByEmail(c, email) {
		// 唯一索引是 user(email COLLATE NOCASE)，二进制 = 用不上它，会全表扫；
		// 邮箱本就按大小写不敏感唯一，NOCASE 比较仍至多命中一行
		return orm(c).select().from(user).where(
			and(
				sql`${user.email} COLLATE NOCASE = ${email}`,
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async insert(c, params) {
		const { userId } = await orm(c).insert(user).values({ ...params }).returning().get();
		return userId;
	},

	selectByEmailIncludeDel(c, email) {
		return orm(c).select().from(user).where(sql`${user.email} COLLATE NOCASE = ${email}`).get();
	},

	selectByIdIncludeDel(c, userId) {
		return orm(c).select().from(user).where(eq(user.userId, userId)).get();
	},

	selectById(c, userId) {
		return orm(c).select().from(user).where(
			and(
				eq(user.userId, userId),
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async delete(c, userId) {
		const userRow = await this.selectByIdIncludeDel(c, userId);
		if (userRow && emailUtils.isSameAddress(userRow.email, c.env.admin)) {
			throw new BizError('The current administrator account cannot be deleted', 403);
		}
		await orm(c).update(user).set({ isDel: isDel.DELETE }).where(eq(user.userId, userId)).run();
		await authInfoCache.remove(c, userId);
	},

	async physicsDelete(c, params) {
		let { userIds } = params;
		userIds = userIds.split(',').map(Number);
		for (const chunk of chunkArray(userIds)) {
			const rows = await orm(c).select({ email: user.email }).from(user).where(inArray(user.userId, chunk)).all();
			if (rows.some(row => emailUtils.isSameAddress(row.email, c.env.admin))) {
				throw new BizError('The current administrator account cannot be deleted', 403);
			}
		}
		for (const chunk of chunkArray(userIds, 20)) {
			await Promise.all(chunk.map(userId => authInfoCache.remove(c, userId)));
		}
		await accountService.physicsDeleteByUserIds(c, userIds);
		await oauthService.deleteByUserIds(c, userIds);
		for (const chunk of chunkArray(userIds)) {
			await orm(c).delete(user).where(inArray(user.userId, chunk)).run();
		}
	},

	async list(c, params) {

		let { num, size, email, timeSort, status } = params;

		size = Number(size);
		num = Number(num);
		timeSort = Number(timeSort);
		params.isDel = Number(params.isDel);
		if (size > 50) {
			size = 50;
		}

		num = (num - 1) * size;

		const conditions = [];

		if (status > -1) {
			conditions.push(eq(user.status, status));
			conditions.push(eq(user.isDel, isDel.NORMAL));
		}


		if (email) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${'%'+ truncateLikeTerm(email) + '%'}`);
		}


		if (params.isDel) {
			conditions.push(eq(user.isDel, params.isDel));
		}


		const query = orm(c).select({
			...user,
			username: oauth.username,
			trustLevel: oauth.trustLevel,
			avatar: oauth.avatar,
			name: oauth.name
		}).from(user).leftJoin(oauth, eq(oauth.userId, user.userId))
			.where(and(...conditions));


		if (timeSort) {
			query.orderBy(asc(user.userId));
		} else {
			query.orderBy(desc(user.userId));
		}

		const list = await query.limit(size).offset(num);

		const { total } = await orm(c)
			.select({ total: count() })
			.from(user)
			.where(and(...conditions)).get();
		const userIds = list.map(user => user.userId);

		const types = [...new Set(list.map(user => user.type))];

		// 统计合并：4 条邮件计数 + 2 条邮箱计数 -> 2 条 GROUP BY，配合角色查询共 3 次往返（原 7 次）
		const [emailStatRows, accountStatRows, roleList] = await Promise.all([
			emailService.selectUserEmailStatList(c, userIds),
			accountService.selectUserAccountStatList(c, userIds),
			roleService.selectByIdsHasPermKey(c, types,'email:send')
		]);

		const receiveMap = {};
		const sendMap = {};
		const accountMap = {};
		const delReceiveMap = {};
		const delSendMap = {};
		const delAccountMap = {};
		for (const row of emailStatRows) {
			const target = row.isDel === isDel.DELETE
				? (row.type === emailConst.type.RECEIVE ? delReceiveMap : delSendMap)
				: (row.type === emailConst.type.RECEIVE ? receiveMap : sendMap);
			target[row.userId] = row.count;
		}
		for (const row of accountStatRows) {
			(row.isDel === isDel.DELETE ? delAccountMap : accountMap)[row.userId] = row.count;
		}

		for (const user of list) {

			const userId = user.userId;

			// 管理列表不返回密码哈希和盐
			delete user.password;
			delete user.salt;

			user.receiveEmailCount = receiveMap[userId] || 0;
			user.sendEmailCount = sendMap[userId] || 0;
			user.accountCount = accountMap[userId] || 0;

			user.delReceiveEmailCount = delReceiveMap[userId] || 0;
			user.delSendEmailCount = delSendMap[userId] || 0;
			user.delAccountCount = delAccountMap[userId] || 0;

			const roleIndex = roleList.findIndex(roleRow => user.type === roleRow.roleId);
			let sendAction = {};

			if (roleIndex > -1) {
				sendAction.sendType = roleList[roleIndex].sendType;
				sendAction.sendCount = roleList[roleIndex].sendCount;
				sendAction.hasPerm = true;
			} else {
				sendAction.hasPerm = false;
			}

			if (emailUtils.isSameAddress(user.email, c.env.admin)) {
				sendAction.sendType = constant.ADMIN_ROLE.sendType;
				sendAction.sendCount = constant.ADMIN_ROLE.sendCount;
				sendAction.hasPerm = true;
				user.type = 0
			}

			user.sendAction = sendAction;
		}

		return { list, total };
	},

	async updateUserInfo(c, userId, recordCreateIp = false) {



		const activeIp = reqUtils.getIp(c);

		const {os, browser, device} = reqUtils.getUserAgent(c);

		const params = {
			os,
			browser,
			device,
			activeIp,
			activeTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
		};

		if (recordCreateIp) {
			params.createIp = activeIp;
		}

		await orm(c)
			.update(user)
			.set(params)
			.where(eq(user.userId, userId))
			.run();
	},

	async setPwd(c, params) {

		const { password, userId } = params;
		// delete / physicsDelete / setStatus 都拦住了管理员这个目标，改密之前漏了：
		// user:set-pwd 是可分配给普通角色的权限，缺这道校验就等于把管理员账号交出去
		const userRow = await this.selectByIdIncludeDel(c, userId);
		if (userRow && emailUtils.isSameAddress(userRow.email, c.env.admin)) {
			const operator = userContext.getUser(c);
			if (!operator || !emailUtils.isSameAddress(operator.email, c.env.admin)) {
				throw new BizError('The administrator password can only be changed by the administrator', 403);
			}
		}
		await replacePassword(c, password, userId);
		await authInfoCache.remove(c, userId);
	},

	async setStatus(c, params) {

		const { status, userId } = params;
		const userRow = await this.selectByIdIncludeDel(c, userId);
		if (userRow
			&& emailUtils.isSameAddress(userRow.email, c.env.admin)
			&& Number(status) !== userConst.status.NORMAL) {
			throw new BizError('The current administrator account cannot be disabled', 403);
		}

		await orm(c)
			.update(user)
			.set({ status })
			.where(eq(user.userId, userId))
			.run();

		// 同函数上方的管理员保护已用 Number(status)，说明字符串入参在预期内；
		// 这里若用严格相等，传 "1" 会封禁入库却跳过撤销，旧会话一路有效到过期
		if (Number(status) === userConst.status.BAN) {
			await authInfoCache.remove(c, userId);
		}
	},

	async setType(c, params) {

		const { type, userId } = params;

		const roleRow = await roleService.selectById(c, type);

		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.userId, userId))
			.run();
		roleService.clearCache();

	},

	async updateAllUserType(c, type, curType) {
		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.type, curType))
			.run();
		roleService.clearCache();
	},

	async add(c, params) {

		const { email, type, password } = params;
		if (emailUtils.isSameAddress(email, c.env.admin)) {
			throw new BizError('Administrator account must be created through the initialization flow', 403);
		}

		if (!isConfiguredDomain(c.env.domain, emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		if (typeof password !== 'string' || password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}
		if (password.length > 30) {
			throw new BizError(t('pwdLengthLimit'));
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		const role = await roleService.selectById(c, type);

		if (!role) {
			throw new BizError(t('roleNotExist'));
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		const userId = await userService.insert(c, { email, password: hash, salt, type });

		await userService.updateUserInfo(c, userId, true);

		await accountService.insert(c, { userId: userId, email, type, name: emailUtils.getName(email) });
	},

	async resetDaySendCount(c) {
		const roleList = await roleService.selectByIdsAndSendType(c, 'email:send', roleConst.sendType.DAY);
		const roleIds = roleList.map(action => action.roleId);
		if (roleIds.length === 0) return;
		await orm(c).update(user).set({ sendCount: 0 }).where(and(
			inArray(user.type, roleIds),
			ne(user.sendCount, 0)
		)).run();
	},

	async resetSendCount(c, params) {
		await orm(c).update(user).set({ sendCount: 0 }).where(eq(user.userId, params.userId)).run();
	},

	async restore(c, params) {
		const { userId, type } = params
		await orm(c)
			.update(user)
			.set({ isDel: isDel.NORMAL })
			.where(eq(user.userId, userId))
			.run();
		const userRow = await this.selectById(c, userId);
		await accountService.restoreByEmail(c, userRow.email);

		if (type) {
			await emailService.restoreByUserId(c, userId);
			await accountService.restoreByUserId(c, userId);
		}

	},

	listByRegKeyId(c, regKeyId) {
		return orm(c)
			.select({email: user.email,createTime: user.createTime})
			.from(user)
			.where(eq(user.regKeyId, regKeyId))
			.orderBy(desc(user.userId))
			.all();
	}
};

export default userService;

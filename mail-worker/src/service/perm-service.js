import orm from '../entity/orm';
import perm from '../entity/perm';
import { eq, ne, and, asc } from 'drizzle-orm';
import rolePerm from '../entity/role-perm';
import user from '../entity/user';
import role from '../entity/role';
import { permConst } from '../const/entity-const';
import { t } from '../i18n/i18n'

const PERM_CACHE_TTL = 30 * 1000;
const permCache = new Map();

function getCache(key) {
	const item = permCache.get(key);
	if (!item || item.expiresAt <= Date.now()) {
		permCache.delete(key);
		return null;
	}
	return item.value;
}

function setCache(key, value) {
	permCache.set(key, {
		value,
		expiresAt: Date.now() + PERM_CACHE_TTL
	});
	return value;
}

function cloneTree(tree) {
	return tree.map(item => ({
		...item,
		children: item.children.map(child => ({ ...child }))
	}));
}

const permService = {
	clearCache() {
		permCache.clear();
	},

	async tree(c) {
		const cacheKey = `tree:${c.req?.header?.('accept-language') || ''}`;
		const cached = getCache(cacheKey);
		if (cached) {
			return cloneTree(cached);
		}

		const pList = await orm(c).select().from(perm).where(eq(perm.pid, 0)).orderBy(asc(perm.sort)).all();
		const cList = await orm(c).select().from(perm).where(ne(perm.pid, 0)).orderBy(asc(perm.sort)).all();

		cList.forEach(cItem => {
			cItem.name = t('perms.' + cItem.name)
		})

		pList.forEach(pItem => {
			pItem.name = t('perms.' + pItem.name)
			pItem.children = cList.filter(cItem => cItem.pid === pItem.permId)
		})
		return cloneTree(setCache(cacheKey, pList));
	},

	async userPermKeys(c, userId) {
		const userRow = c.get?.('user');
		const cacheKey = `userPerm:${userId}:${userRow?.type || ''}`;
		const cached = getCache(cacheKey);
		if (cached) {
			return [...cached];
		}

		const userPerms = await orm(c).select({permKey: perm.permKey}).from(user)
			.leftJoin(role, eq(role.roleId,user.type))
			.rightJoin(rolePerm, eq(rolePerm.roleId,role.roleId))
			.leftJoin(perm, eq(rolePerm.permId,perm.permId))
			.where(and(eq(user.userId,userId),eq(perm.type,permConst.type.BUTTON)))
			.all();
		return [...setCache(cacheKey, userPerms.map(perm => perm.permKey))];
	}
}

export default permService

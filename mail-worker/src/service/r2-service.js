import s3Service from './s3-service';
import settingService from './setting-service';
import kvObjService from './kv-obj-service';

const r2Service = {

	async storageType(c) {

		const setting = await settingService.query(c);
		const { bucket, endpoint, s3AccessKey, s3SecretKey } = setting;

		if (!!(bucket && endpoint && s3AccessKey && s3SecretKey)) {
			return 'S3';
		}

		if (c.env.r2) {
			return 'R2';
		}

		return 'KV';
	},

	async putObj(c, key, content, metadata) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.putObj(c, key, content, metadata);
		}

		if (storageType === 'R2') {
			await c.env.r2.put(key, content, {
				httpMetadata: { ...metadata }
			});
		}

		if (storageType === 'S3') {
			await s3Service.putObj(c, key, content, metadata);
		}

	},

	async getObj(c, key) {
		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			return await kvObjService.getObj(c, key);
		}

		if (storageType === 'R2') {
			return await c.env.r2.get(key);
		}

		if (storageType === 'S3') {
			return await s3Service.getObj(c, key);
		}
	},

	toResponse(obj, extraHeaders = {}) {
		if (!obj) {
			return null;
		}

		const headers = new Headers();
		let body = obj.body;

		if (obj instanceof Response) {
			body = obj.body;
			obj.headers.forEach((value, key) => {
				if (value && value !== 'null') {
					headers.set(key, value);
				}
			});
		} else if (typeof obj.writeHttpMetadata === 'function') {
			obj.writeHttpMetadata(headers);
		} else if (obj.httpMetadata) {
			if (obj.httpMetadata.contentType) headers.set('Content-Type', obj.httpMetadata.contentType);
			if (obj.httpMetadata.contentDisposition) headers.set('Content-Disposition', obj.httpMetadata.contentDisposition);
			if (obj.httpMetadata.cacheControl) headers.set('Cache-Control', obj.httpMetadata.cacheControl);
		}

		if (!headers.get('Content-Type')) {
			headers.set('Content-Type', 'application/octet-stream');
		}

		Object.entries(extraHeaders).forEach(([key, value]) => {
			if (value !== undefined && value !== null && value !== '') {
				headers.set(key, value);
			}
		});

		return new Response(body, { headers });
	},

	async delete(c, key) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.deleteObj(c, key);
		}

		if (storageType === 'R2') {
			await c.env.r2.delete(key);
		}

		if (storageType === 'S3'){
			await s3Service.deleteObj(c, key);
		}

	}

};
export default r2Service;

const encoder = new TextEncoder();

const saltHashUtils = {

	generateSalt(length = 16) {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return btoa(String.fromCharCode(...array));
	},


	async hashPassword(password) {
		const salt = this.generateSalt();
		const hash = await this.genHashPassword(password, salt);
		return { salt, hash };
	},

	async genHashPassword(password, salt) {
		const data = encoder.encode(salt + password);
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return btoa(String.fromCharCode(...hashArray));
	},

	async verifyPassword(inputPassword, salt, storedHash) {
		const hash = await this.genHashPassword(inputPassword, salt);
		return hash === storedHash;
	},

	genRandomPwd(length = 8) {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		const maxUnbiasedByte = Math.floor(256 / chars.length) * chars.length;

		while (result.length < length) {
			const bytes = new Uint8Array(Math.max(length - result.length, 1));
			crypto.getRandomValues(bytes);
			for (const byte of bytes) {
				if (byte >= maxUnbiasedByte) {
					continue;
				}
				result += chars.charAt(byte % chars.length);
				if (result.length === length) {
					break;
				}
			}
		}
		return result;
	}
};

export default saltHashUtils;

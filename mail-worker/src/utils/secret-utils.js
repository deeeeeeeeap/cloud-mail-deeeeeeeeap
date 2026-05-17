const encoder = new TextEncoder();

const secretUtils = {
	async timingSafeEqual(a, b) {
		const left = encoder.encode(String(a ?? ''));
		const right = encoder.encode(String(b ?? ''));

		if (left.length !== right.length) {
			await Promise.all([
				crypto.subtle.digest('SHA-256', left),
				crypto.subtle.digest('SHA-256', right)
			]);
			return false;
		}

		let diff = 0;
		for (let i = 0; i < left.length; i++) {
			diff |= left[i] ^ right[i];
		}

		return diff === 0;
	},

	timingSafeBytesEqual(left, right) {
		if (left.length !== right.length) {
			return false;
		}

		let diff = 0;
		for (let i = 0; i < left.length; i++) {
			diff |= left[i] ^ right[i];
		}

		return diff === 0;
	}
};

export default secretUtils;

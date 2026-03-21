/**
 * Monotonic ULID generator — zero dependencies.
 *
 * Format: 26-char Crockford base32 string
 *   - 10 chars: 48-bit millisecond timestamp
 *   - 16 chars: 80-bit random (monotonically incremented within same ms)
 *
 * Lexicographically sortable = time-ordered.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
// 10 bytes = 80 bits of randomness
const lastRandom = new Uint8Array(10);

function encodeTime(ms: number, len: number): string {
	let str = "";
	let t = ms;
	for (let i = len - 1; i >= 0; i--) {
		const mod = t % 32;
		str = CROCKFORD.charAt(mod) + str;
		t = Math.floor(t / 32);
	}
	return str;
}

function encodeRandom(bytes: Uint8Array): string {
	// 10 bytes = 80 bits → 16 base32 chars
	// Process as two 40-bit groups for precision (JS safe integer = 53 bits)
	let str = "";

	// First 5 bytes → 8 chars
	let val =
		(bytes[0] as number) * 2 ** 32 +
		(bytes[1] as number) * 2 ** 24 +
		(bytes[2] as number) * 2 ** 16 +
		(bytes[3] as number) * 2 ** 8 +
		(bytes[4] as number);
	for (let i = 7; i >= 0; i--) {
		str = CROCKFORD.charAt(val % 32) + str;
		val = Math.floor(val / 32);
	}

	// Last 5 bytes → 8 chars
	let str2 = "";
	val =
		(bytes[5] as number) * 2 ** 32 +
		(bytes[6] as number) * 2 ** 24 +
		(bytes[7] as number) * 2 ** 16 +
		(bytes[8] as number) * 2 ** 8 +
		(bytes[9] as number);
	for (let i = 7; i >= 0; i--) {
		str2 = CROCKFORD.charAt(val % 32) + str2;
		val = Math.floor(val / 32);
	}

	return str + str2;
}

function incrementRandom(bytes: Uint8Array): boolean {
	// Increment the random part as a big-endian 80-bit integer
	for (let i = bytes.length - 1; i >= 0; i--) {
		if ((bytes[i] as number) < 255) {
			(bytes[i] as number)++;
			return true;
		}
		bytes[i] = 0;
	}
	// Overflow — all bytes were 255
	return false;
}

/**
 * Generate a monotonic ULID.
 *
 * Same millisecond → increments random part (preserves sort order).
 * New millisecond → fresh random bytes.
 */
export function ulid(): string {
	const now = Date.now();

	if (now === lastTime) {
		// Same ms: increment random for monotonicity
		if (!incrementRandom(lastRandom)) {
			// Overflow — extremely unlikely (2^80 calls in 1ms)
			// Wait for next ms
			let next = Date.now();
			while (next === lastTime) {
				next = Date.now();
			}
			lastTime = next;
			crypto.getRandomValues(lastRandom);
		}
	} else {
		lastTime = now;
		crypto.getRandomValues(lastRandom);
	}

	return encodeTime(lastTime, 10) + encodeRandom(lastRandom);
}

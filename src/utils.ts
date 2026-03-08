const UNITS = ["Bytes", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatBytes(n: number): string {
	if (n === 0) return "0 Bytes";
	if (n < 0) return `-${formatBytes(-n)}`;

	const exponent = Math.min(
		Math.floor(Math.log(n) / Math.log(1024)),
		UNITS.length - 1,
	);
	const value = n / 1024 ** exponent;
	const unit = UNITS[exponent];

	if (exponent === 0) return `${n} ${unit}`;
	return `${value.toFixed(1)} ${unit}`;
}

export function truncate(text: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	if (text.length <= maxLen) return text;
	if (maxLen <= 3) return "...".slice(0, maxLen);
	return `${text.slice(0, maxLen - 3)}...`;
}

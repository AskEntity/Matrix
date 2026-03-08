const TRANSLITERATIONS: Record<string, string> = {
	à: "a",
	á: "a",
	â: "a",
	ã: "a",
	ä: "a",
	å: "a",
	è: "e",
	é: "e",
	ê: "e",
	ë: "e",
	ì: "i",
	í: "i",
	î: "i",
	ï: "i",
	ò: "o",
	ó: "o",
	ô: "o",
	õ: "o",
	ö: "o",
	ù: "u",
	ú: "u",
	û: "u",
	ü: "u",
	ñ: "n",
	ç: "c",
	ß: "ss",
	ð: "d",
	ø: "o",
	æ: "ae",
	À: "A",
	Á: "A",
	Â: "A",
	Ã: "A",
	Ä: "A",
	Å: "A",
	È: "E",
	É: "E",
	Ê: "E",
	Ë: "E",
	Ì: "I",
	Í: "I",
	Î: "I",
	Ï: "I",
	Ò: "O",
	Ó: "O",
	Ô: "O",
	Õ: "O",
	Ö: "O",
	Ù: "U",
	Ú: "U",
	Û: "U",
	Ü: "U",
	Ñ: "N",
	Ç: "C",
	Ð: "D",
	Ø: "O",
	Æ: "AE",
};

function transliterate(text: string): string {
	return text.replace(/[^\u0020-\u007E]/g, (ch) => TRANSLITERATIONS[ch] ?? "");
}

export function toSlug(text: string): string {
	if (text === "") return "";

	return transliterate(text.replace(/\s+/g, " "))
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

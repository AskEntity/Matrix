import { describe, expect, test } from "bun:test";
import { toSlug } from "./slug.ts";

describe("toSlug", () => {
	test("converts basic text to slug", () => {
		expect(toSlug("Hello World")).toBe("hello-world");
	});

	test("converts to lowercase", () => {
		expect(toSlug("HELLO WORLD")).toBe("hello-world");
	});

	test("handles mixed case", () => {
		expect(toSlug("HeLLo WoRLd")).toBe("hello-world");
	});

	test("removes special characters", () => {
		expect(toSlug("hello! @world# $test")).toBe("hello-world-test");
	});

	test("collapses multiple spaces into single hyphen", () => {
		expect(toSlug("hello    world")).toBe("hello-world");
	});

	test("collapses multiple hyphens into one", () => {
		expect(toSlug("hello---world")).toBe("hello-world");
	});

	test("trims leading and trailing whitespace", () => {
		expect(toSlug("  hello world  ")).toBe("hello-world");
	});

	test("trims leading and trailing hyphens", () => {
		expect(toSlug("--hello-world--")).toBe("hello-world");
	});

	test("handles unicode/accented characters", () => {
		expect(toSlug("café résumé")).toBe("cafe-resume");
		expect(toSlug("jalapeño")).toBe("jalapeno");
		expect(toSlug("über cool")).toBe("uber-cool");
		expect(toSlug("naïve")).toBe("naive");
	});

	test("handles numbers in text", () => {
		expect(toSlug("hello 123 world")).toBe("hello-123-world");
		expect(toSlug("version 2.0")).toBe("version-2-0");
	});

	test("is idempotent for already-slugified text", () => {
		expect(toSlug("hello-world")).toBe("hello-world");
		expect(toSlug("already-a-slug")).toBe("already-a-slug");
	});

	test("returns empty string for empty input", () => {
		expect(toSlug("")).toBe("");
	});

	test("returns empty string for only special characters", () => {
		expect(toSlug("!@#$%^&*()")).toBe("");
	});

	test("handles consecutive special characters", () => {
		expect(toSlug("hello!!!world")).toBe("hello-world");
		expect(toSlug("a@#$b")).toBe("a-b");
	});

	test("handles tabs and newlines", () => {
		expect(toSlug("hello\tworld\nfoo")).toBe("hello-world-foo");
	});

	test("handles German ß", () => {
		expect(toSlug("straße")).toBe("strasse");
	});

	test("handles æ and ø", () => {
		expect(toSlug("Ærø")).toBe("aero");
	});
});

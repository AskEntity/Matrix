import { describe, it, expect } from "vitest";
import { capitalize, reverse } from "./strings";

describe("capitalize", () => {
  it("capitalizes the first letter of a lowercase word", () => {
    expect(capitalize("hello")).toBe("Hello");
  });

  it("returns the same string if already capitalized", () => {
    expect(capitalize("Hello")).toBe("Hello");
  });

  it("handles an empty string", () => {
    expect(capitalize("")).toBe("");
  });

  it("capitalizes a single character", () => {
    expect(capitalize("a")).toBe("A");
  });

  it("does not change the rest of the string", () => {
    expect(capitalize("hELLO")).toBe("HELLO");
  });

  it("handles strings starting with a number", () => {
    expect(capitalize("1abc")).toBe("1abc");
  });

  it("handles strings with spaces", () => {
    expect(capitalize("hello world")).toBe("Hello world");
  });

  it("handles unicode characters", () => {
    expect(capitalize("über")).toBe("Über");
  });
});

describe("reverse", () => {
  it("reverses a simple word", () => {
    expect(reverse("hello")).toBe("olleh");
  });

  it("handles an empty string", () => {
    expect(reverse("")).toBe("");
  });

  it("handles a single character", () => {
    expect(reverse("a")).toBe("a");
  });

  it("handles a palindrome", () => {
    expect(reverse("racecar")).toBe("racecar");
  });

  it("handles strings with spaces", () => {
    expect(reverse("hello world")).toBe("dlrow olleh");
  });

  it("handles unicode/emoji characters", () => {
    expect(reverse("abc😀")).toBe("😀cba");
  });

  it("preserves case", () => {
    expect(reverse("Hello")).toBe("olleH");
  });
});

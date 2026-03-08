/**
 * Capitalizes the first character of a string.
 * Returns an empty string if given an empty string.
 */
export function capitalize(str: string): string {
  if (str.length === 0) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Reverses a string.
 */
export function reverse(str: string): string {
  return [...str].reverse().join("");
}

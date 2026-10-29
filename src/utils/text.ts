/** Whether `value` holds a C0 control character or DEL (RFC 7617 forbids them in credentials). */
export function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => char < " " || char === "\u007f");
}

export const protectedTouchKeyboardLetterRows = [
  Array.from("qwertyuiop"),
  Array.from("asdfghjkl"),
  Array.from("zxcvbnm"),
] as const;

export const protectedTouchKeyboardNumberRows = [
  Array.from("1234567890"),
] as const;

export const protectedTouchKeyboardSymbolRows = [
  Array.from("`~!@#$%^&*()"),
  Array.from("-_+=[]{}<>"),
  Array.from(".,:;/?\\|'\""),
] as const;

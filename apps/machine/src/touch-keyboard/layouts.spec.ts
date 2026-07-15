import { describe, expect, it } from "vitest";

import {
  protectedTouchKeyboardLetterRows,
  protectedTouchKeyboardNumberRows,
  protectedTouchKeyboardSymbolRows,
} from "./layouts";

describe("protected touch keyboard layouts", () => {
  it("reaches every printable ASCII character required by Wi-Fi passwords", () => {
    const lowerLetters = protectedTouchKeyboardLetterRows.flat();
    const reachable = new Set([
      ...lowerLetters,
      ...lowerLetters.map((character) => character.toUpperCase()),
      ...protectedTouchKeyboardNumberRows.flat(),
      ...protectedTouchKeyboardSymbolRows.flat(),
      " ",
    ]);
    const printableAscii = Array.from({ length: 95 }, (_, index) =>
      String.fromCharCode(32 + index),
    );

    expect([...reachable].sort()).toEqual(printableAscii.sort());
    for (const character of ["~", "`", "'", '"', "<", ">", "\\", "|"]) {
      expect(reachable.has(character)).toBe(true);
    }
  });
});

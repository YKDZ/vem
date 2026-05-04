import { Injectable } from "@nestjs/common";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

async function scryptAsync(
  password: string,
  salt: string,
  keylen: number,
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, key) => {
      if (err !== null) reject(err);
      else resolve(key);
    });
  });
}

@Injectable()
export class PasswordService {
  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString("hex");
    const derived = await scryptAsync(password, salt, KEY_LENGTH);
    return `scrypt:${salt}:${derived.toString("hex")}`;
  }

  async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    const [algorithm, salt, hash] = storedHash.split(":");
    if (algorithm !== "scrypt" || !salt || !hash) {
      return false;
    }
    const expected = Buffer.from(hash, "hex");
    const actual = await scryptAsync(password, salt, expected.length);
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
}

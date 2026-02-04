// src/core/crypto.ts
//
// Forge Crypto Module (core helpers + runtime adapters)
// ----------------------------------------------------
// This module provides reusable crypto utilities for Forge runtime:
//
// - Hashing (md5, sha256)
// - Base64 encode/decode
// - Key generation
// - UUID generation
// - AES-256-GCM encrypt/decrypt (safe default)
//
// IMPORTANT:
// - This module uses Node's 'crypto' when available.
// - In the evaluator/runtime you can inject adapters. Here we export a factory
//   that creates the Crypto module using a provided Node crypto instance.
//
// Exports:
//   - createCryptoModule(nodeCrypto): ForgeCryptoModule
//   - normalizeAesKeyHex(keyHex): Buffer
//   - aesEncryptGcm / aesDecryptGcm
//   - base64Encode / base64Decode
//
// This is meant to be used by run.ts to implement `Crypto.*` builtins.

import type * as NodeCrypto from "crypto";

export type ForgeCryptoModule = {
  hash: {
    md5: (text: string) => string;
    sha256: (text: string) => string;
  };
  base64: {
    encode: (text: string) => string;
    decode: (textB64: string) => string;
  };
  generate: {
    key: (bits: number) => string; // hex
    uuid: () => string;
  };
  aes: {
    encrypt: (plain: string, keyHex: string) => string; // base64 payload (iv|tag|cipher)
    decrypt: (cipherB64: string, keyHex: string) => string; // plaintext
  };
  random: (min: number, max: number) => number;
};

export function createCryptoModule(crypto: typeof import("crypto")): ForgeCryptoModule {
  return {
    hash: {
      md5: (text: string) => hashHex(crypto, "md5", text),
      sha256: (text: string) => hashHex(crypto, "sha256", text),
    },
    base64: {
      encode: (text: string) => base64Encode(text),
      decode: (b64: string) => base64Decode(b64),
    },
    generate: {
      key: (bits: number) => generateKeyHex(crypto, bits),
      uuid: () => generateUuid(crypto),
    },
    aes: {
      encrypt: (plain: string, keyHex: string) => aesEncryptGcm(crypto, plain, keyHex),
      decrypt: (cipherB64: string, keyHex: string) => aesDecryptGcm(crypto, cipherB64, keyHex),
    },
    random: (min: number, max: number) => randomIntInclusive(crypto, min, max),
  };
}

/* =========================================================
   Hashing
   ========================================================= */

export function hashHex(crypto: typeof import("crypto"), alg: "md5" | "sha256", text: string): string {
  return crypto.createHash(alg).update(String(text ?? ""), "utf8").digest("hex");
}

/* =========================================================
   Base64
   ========================================================= */

export function base64Encode(text: string): string {
  return Buffer.from(String(text ?? ""), "utf8").toString("base64");
}

export function base64Decode(textB64: string): string {
  return Buffer.from(String(textB64 ?? ""), "base64").toString("utf8");
}

/* =========================================================
   Key / UUID
   ========================================================= */

export function generateKeyHex(crypto: typeof import("crypto"), bits: number): string {
  const b = Number(bits);
  // Clamp: 128..4096 bits
  const clampedBits = Math.max(128, Math.min(4096, Math.floor(Number.isFinite(b) ? b : 256)));
  const bytes = Math.max(16, Math.floor(clampedBits / 8));
  return crypto.randomBytes(bytes).toString("hex");
}

export function generateUuid(crypto: typeof import("crypto")): string {
  // Node >= 14.17 has randomUUID
  if (typeof (crypto as any).randomUUID === "function") return (crypto as any).randomUUID();
  // fallback: UUIDv4-ish from random bytes
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("").replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    "$1-$2-$3-$4-$5"
  );
}

/* =========================================================
   AES-256-GCM (iv|tag|ciphertext)
   ========================================================= */

export function aesEncryptGcm(
  crypto: typeof import("crypto"),
  plain: string,
  keyHex: string
): string {
  const key = normalizeAesKeyHex(crypto, keyHex);
  const iv = crypto.randomBytes(12); // recommended IV length for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const enc = Buffer.concat([cipher.update(String(plain ?? ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // payload format: iv (12) | tag (16) | ciphertext (n)
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function aesDecryptGcm(
  crypto: typeof import("crypto"),
  cipherB64: string,
  keyHex: string
): string {
  const key = normalizeAesKeyHex(crypto, keyHex);
  const raw = Buffer.from(String(cipherB64 ?? ""), "base64");

  if (raw.length < 12 + 16) {
    throw new Error("Invalid AES payload (too short). Expected iv(12)+tag(16)+ciphertext.");
  }

  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/**
 * Normalize a hex key to 32 bytes for AES-256.
 * - If key hex decodes to exactly 32 bytes -> use as-is
 * - If longer -> slice to 32 bytes
 * - If shorter -> SHA256 hash it into 32 bytes
 */
export function normalizeAesKeyHex(
  crypto: typeof import("crypto"),
  keyHex: string
): Buffer {
  const hex = String(keyHex ?? "").trim();

  let raw: Buffer;
  try {
    raw = Buffer.from(hex, "hex");
  } catch {
    raw = Buffer.from(hex, "utf8");
  }

  if (raw.length === 32) return raw;
  if (raw.length > 32) return raw.subarray(0, 32);
  return crypto.createHash("sha256").update(raw).digest(); // 32 bytes
}

/* =========================================================
   Random
   ========================================================= */

export function randomIntInclusive(
  crypto: typeof import("crypto"),
  min: number,
  max: number
): number {
  const a = Math.floor(Number(min));
  const b = Math.floor(Number(max));
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  if (lo === hi) return lo;

  // crypto.randomInt is inclusive-exclusive: [min, max)
  // We want inclusive: [lo, hi]
  return lo + crypto.randomInt(hi - lo + 1);
}

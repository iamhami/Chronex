import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

import type {
  EncryptedProfileRecord,
  EncryptedSensitiveField,
  KeyResolver,
  SensitiveProfileInput
} from "./types.ts";

const ENCRYPTION_PREFIX = "chronex.enc.v1";
const SENSITIVE_PROFILE_FIELDS = ["condition", "lifestyle"] as const;

export class SensitiveDecryptError extends Error {
  readonly code = "SENSITIVE_DECRYPT_ERROR";

  constructor(message = "Unable to decrypt sensitive value.") {
    super(message);
    this.name = "SensitiveDecryptError";
  }
}

export function createSensitiveCrypto(keyResolver: KeyResolver) {
  return {
    encryptSensitive(value: string, keyId: string): string {
      const iv = randomBytes(12);
      const key = deriveKey(keyResolver.resolveKey(keyId));
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final()
      ]);
      const authTag = cipher.getAuthTag();

      return serializeEnvelope({
        keyId,
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        authTag: authTag.toString("base64url")
      });
    },

    decryptSensitive(ciphertext: string, keyId: string): string {
      const envelope = parseEnvelope(ciphertext);

      if (envelope.keyId !== keyId) {
        throw new SensitiveDecryptError();
      }

      try {
        const key = deriveKey(keyResolver.resolveKey(keyId));
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(envelope.iv, "base64url")
        );
        decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));

        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
          decipher.final()
        ]);

        return plaintext.toString("utf8");
      } catch {
        throw new SensitiveDecryptError();
      }
    }
  };
}

export function encryptSensitiveProfile(
  input: SensitiveProfileInput,
  keyId: string,
  keyResolver: KeyResolver
): EncryptedProfileRecord {
  const crypto = createSensitiveCrypto(keyResolver);
  const encrypted: EncryptedProfileRecord = {};

  if (input.bio) {
    encrypted.bio = input.bio;
  }

  for (const field of SENSITIVE_PROFILE_FIELDS) {
    const value = input[field];
    if (!value) {
      continue;
    }

    encrypted[field] = {
      keyId,
      ciphertext: crypto.encryptSensitive(value, keyId)
    } satisfies EncryptedSensitiveField;
  }

  return encrypted;
}

export function decryptSensitiveProfile(
  input: EncryptedProfileRecord,
  keyResolver: KeyResolver
): SensitiveProfileInput {
  const decrypted: SensitiveProfileInput = {};

  if (input.bio) {
    decrypted.bio = input.bio;
  }

  for (const field of SENSITIVE_PROFILE_FIELDS) {
    const encryptedField = input[field];
    if (!encryptedField) {
      continue;
    }

    const crypto = createSensitiveCrypto(keyResolver);
    decrypted[field] = crypto.decryptSensitive(
      encryptedField.ciphertext,
      encryptedField.keyId
    );
  }

  return decrypted;
}

function deriveKey(keyMaterial: Uint8Array): Buffer {
  return createHash("sha256").update(keyMaterial).digest();
}

function serializeEnvelope(envelope: {
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}): string {
  return `${ENCRYPTION_PREFIX}.${Buffer.from(
    JSON.stringify(envelope),
    "utf8"
  ).toString("base64url")}`;
}

function parseEnvelope(ciphertext: string): {
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
} {
  const prefixWithDelimiter = `${ENCRYPTION_PREFIX}.`;
  if (!ciphertext.startsWith(prefixWithDelimiter)) {
    throw new SensitiveDecryptError();
  }

  const payload = ciphertext.slice(prefixWithDelimiter.length);
  if (!payload) {
    throw new SensitiveDecryptError();
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as {
      keyId?: string;
      iv?: string;
      ciphertext?: string;
      authTag?: string;
    };

    if (
      !parsed.keyId
      || !parsed.iv
      || !parsed.ciphertext
      || !parsed.authTag
    ) {
      throw new SensitiveDecryptError();
    }

    return {
      keyId: parsed.keyId,
      iv: parsed.iv,
      ciphertext: parsed.ciphertext,
      authTag: parsed.authTag
    };
  } catch {
    throw new SensitiveDecryptError();
  }
}

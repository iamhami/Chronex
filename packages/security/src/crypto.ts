import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

import { SensitiveCryptoError } from "./errors.ts";
import type {
  KeyManagementService,
  SensitiveFieldCipher
} from "./types.ts";
import { SecurityTelemetry } from "./telemetry.ts";

type SensitiveCryptoServiceOptions = {
  keyManagementService: KeyManagementService;
  telemetry?: SecurityTelemetry;
};

export class InMemoryKeyManagementService implements KeyManagementService {
  private readonly keyMaterial = new Map<string, Buffer>();

  constructor(seed: Record<string, string | Buffer>) {
    for (const [keyId, material] of Object.entries(seed)) {
      this.keyMaterial.set(
        keyId,
        Buffer.isBuffer(material) ? Buffer.from(material) : Buffer.from(material)
      );
    }
  }

  getKeyMaterial(keyId: string): Buffer {
    const material = this.keyMaterial.get(keyId);
    if (!material) {
      throw new SensitiveCryptoError("Unknown key id.", keyId);
    }

    return Buffer.from(material);
  }
}

export class SensitiveCryptoService {
  private readonly keyManagementService: KeyManagementService;
  private readonly telemetry?: SecurityTelemetry;

  constructor(options: SensitiveCryptoServiceOptions) {
    this.keyManagementService = options.keyManagementService;
    this.telemetry = options.telemetry;
  }

  encryptSensitive(value: string, keyId: string): string {
    const normalizedKeyId = normalizeRequiredText("keyId", keyId);
    const key = deriveKey(this.keyManagementService.getKeyMaterial(normalizedKeyId));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();
    return [
      "enc",
      "v1",
      normalizedKeyId,
      iv.toString("base64url"),
      authTag.toString("base64url"),
      encrypted.toString("base64url")
    ].join(":");
  }

  decryptSensitive(ciphertext: string): string {
    let keyId: string | undefined;

    try {
      const [prefix, version, parsedKeyId, iv, authTag, encrypted] =
        ciphertext.split(":");
      keyId = parsedKeyId;

      if (
        prefix !== "enc"
        || version !== "v1"
        || !parsedKeyId
        || !iv
        || !authTag
        || !encrypted
      ) {
        throw new SensitiveCryptoError(
          "Ciphertext format is invalid.",
          parsedKeyId
        );
      }

      const key = deriveKey(this.keyManagementService.getKeyMaterial(parsedKeyId));
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64url")
      );
      decipher.setAuthTag(Buffer.from(authTag, "base64url"));

      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64url")),
        decipher.final()
      ]).toString("utf8");
    } catch (error) {
      this.telemetry?.incrementSensitiveDecryptFailure();
      if (error instanceof SensitiveCryptoError) {
        throw error;
      }

      throw new SensitiveCryptoError(
        "Sensitive ciphertext could not be decrypted.",
        keyId
      );
    }
  }
}

export function createSensitiveFieldCipher(
  keyId: string,
  cryptoService: SensitiveCryptoService
): SensitiveFieldCipher {
  const normalizedKeyId = normalizeRequiredText("keyId", keyId);
  return {
    keyId: normalizedKeyId,
    encrypt(value: string): string {
      return cryptoService.encryptSensitive(value, normalizedKeyId);
    },
    decrypt(value: string): string {
      return cryptoService.decryptSensitive(value);
    }
  };
}

function deriveKey(material: Buffer): Buffer {
  return createHash("sha256").update(material).digest();
}

function normalizeRequiredText(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new SensitiveCryptoError(`${field} is required.`);
  }

  return normalized;
}

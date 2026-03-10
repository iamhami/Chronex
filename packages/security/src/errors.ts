export class SensitiveCryptoError extends Error {
  readonly keyId?: string;

  constructor(message: string, keyId?: string) {
    super(message);
    this.name = "SensitiveCryptoError";
    this.keyId = keyId;
  }
}

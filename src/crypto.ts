import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts secrets stored in the database (AES-256-GCM, random IV, authenticated).
 * Format: "v1:<iv>:<tag>:<ciphertext>", base64 parts. The key comes from SECRETS_KEY and never touches the database.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded");
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
  }

  open(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(":");
    if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("Unknown secret format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  }
}

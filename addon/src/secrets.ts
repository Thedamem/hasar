import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { promises as fs } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";

const PREFIX = "enc:v1:";
const KEY_FILE = "master.key";
const KEY_BYTES = 32;
const IV_BYTES = 12;

const keyCache = new Map<string, Promise<Buffer>>();

function keyFromEnv(): Buffer | null {
  const raw = process.env.HASAR_SECRET?.trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  // A passphrase is accepted for users who keep the key outside /data.
  return scryptSync(raw, "hasar-addon-v1", KEY_BYTES);
}

async function readKeyFile(file: string): Promise<Buffer | null> {
  try {
    const raw = await fs.readFile(file);
    if (raw.length !== KEY_BYTES) {
      throw new Error(`${KEY_FILE} must contain exactly ${KEY_BYTES} bytes`);
    }
    await chmod(file, 0o600).catch(() => undefined);
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function createKeyFile(file: string): Promise<Buffer> {
  const key = randomBytes(KEY_BYTES);
  try {
    await fs.writeFile(file, key, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readKeyFile(file);
    if (!existing) throw new Error(`${KEY_FILE} disappeared during creation`);
    return existing;
  }
}

async function loadKey(dataDir: string): Promise<Buffer> {
  const cached = keyCache.get(dataDir);
  if (cached) return cached;

  const pending = (async () => {
    const fromEnv = keyFromEnv();
    if (fromEnv) return fromEnv;

    await mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, KEY_FILE);
    return (await readKeyFile(file)) ?? (await createKeyFile(file));
  })();

  keyCache.set(dataDir, pending);
  try {
    return await pending;
  } catch (error) {
    keyCache.delete(dataDir);
    throw error;
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

export async function sealSecret(dataDir: string, value: string): Promise<string> {
  if (!value || isEncrypted(value)) return value;
  const key = await loadKey(dataDir);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export async function openSecret(dataDir: string, value: string): Promise<string> {
  if (!value) return "";
  if (!isEncrypted(value)) return value;

  const key = await loadKey(dataDir);
  const body = value.slice(PREFIX.length);
  const [ivPart, tagPart, dataPart] = body.split(".");
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error("secret has an invalid encoding");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

import { argon2id } from "hash-wasm";
import type { EncryptedPayload, KdfParams, KeyMaterial, VaultData } from "./types";

export const DEFAULT_KDF: KdfParams = {
  algorithm: "argon2id",
  memorySize: 65_536,
  iterations: 3,
  parallelism: 1,
  hashLength: 64,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function deriveKeyMaterial(masterPassword: string, salt: string, params: KdfParams): Promise<KeyMaterial> {
  if (masterPassword.length < 12) throw new Error("Das Masterpasswort muss mindestens 12 Zeichen lang sein.");
  const derived = await argon2id({
    password: masterPassword,
    salt: fromBase64(salt),
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySize,
    hashLength: params.hashLength,
    outputType: "binary",
  });
  const bytes = derived instanceof Uint8Array ? derived : new Uint8Array(derived);
  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(bytes.slice(0, 32)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const authPrefix = encoder.encode("central-vault-auth-v1");
  const authInput = new Uint8Array(authPrefix.length + 32);
  authInput.set(authPrefix);
  authInput.set(bytes.slice(32, 64), authPrefix.length);
  const authDigest = await crypto.subtle.digest("SHA-256", asArrayBuffer(authInput));
  bytes.fill(0);
  return { encryptionKey, authToken: toBase64Url(new Uint8Array(authDigest)) };
}

/**
 * Das Salt muss vor der Anmeldung feststehen, weil Supabase ohne JWT nichts
 * herausgibt. Deshalb deterministisch aus der E-Mail statt zufällig vom Server.
 */
export async function deriveSaltFromEmail(email: string): Promise<string> {
  const input = encoder.encode(`central-vault-salt-v2:${email.trim().toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", asArrayBuffer(input));
  return toBase64(new Uint8Array(digest));
}

function additionalData(vaultId: string): Uint8Array {
  return encoder.encode(`central-vault:v1:${vaultId}`);
}

export async function encryptVault(data: VaultData, key: CryptoKey, vaultId: string, version: number): Promise<EncryptedPayload> {
  const iv = randomBytes(12);
  const plaintext = encoder.encode(JSON.stringify(data));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv), additionalData: asArrayBuffer(additionalData(vaultId)), tagLength: 128 },
    key,
    plaintext,
  );
  plaintext.fill(0);
  return {
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encrypted)),
    version,
    updatedAt: data.updatedAt,
  };
}

export async function decryptVault(payload: EncryptedPayload, key: CryptoKey, vaultId: string): Promise<VaultData> {
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asArrayBuffer(fromBase64(payload.iv)),
        additionalData: asArrayBuffer(additionalData(vaultId)),
        tagLength: 128,
      },
      key,
      asArrayBuffer(fromBase64(payload.ciphertext)),
    );
    return JSON.parse(decoder.decode(decrypted)) as VaultData;
  } catch {
    throw new Error("Masterpasswort falsch oder Tresordaten beschädigt.");
  }
}

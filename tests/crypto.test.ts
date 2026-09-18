import { describe, expect, it } from "vitest";
import { decryptVault, deriveKeyMaterial, encryptVault, randomBytes, toBase64 } from "../src/crypto";
import { createEmptyVault } from "../src/importers";
import type { KdfParams } from "../src/types";

describe("vault encryption", () => {
  it("round-trips data and rejects a wrong password", async () => {
    const params: KdfParams = { algorithm: "argon2id", memorySize: 1024, iterations: 1, parallelism: 1, hashLength: 64 };
    const salt = toBase64(randomBytes(16));
    const vaultId = crypto.randomUUID();
    const vault = createEmptyVault();
    vault.name = "Test";
    const right = await deriveKeyMaterial("correct horse battery staple", salt, params);
    const encrypted = await encryptVault(vault, right.encryptionKey, vaultId, 1);
    expect(encrypted.ciphertext).not.toContain("Test");
    await expect(decryptVault(encrypted, right.encryptionKey, vaultId)).resolves.toMatchObject({ name: "Test" });
    const wrong = await deriveKeyMaterial("different master password", salt, params);
    await expect(decryptVault(encrypted, wrong.encryptionKey, vaultId)).rejects.toThrow(/falsch|beschädigt/);
  });
});

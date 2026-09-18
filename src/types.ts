export type Area = "private" | "work";

export interface CustomField {
  id: string;
  name: string;
  value: string;
  concealed?: boolean;
}

export interface VaultEntry {
  id: string;
  area: Area;
  category: string;
  title: string;
  username: string;
  password: string;
  urls: string[];
  notes: string;
  fields: CustomField[];
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VaultData {
  schemaVersion: 1;
  name: string;
  categories: Record<Area, string[]>;
  entries: VaultEntry[];
  deletedEntries: Record<string, string>;
  settings: {
    autoLockMinutes: number;
    clipboardSeconds: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface KdfParams {
  algorithm: "argon2id";
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: 64;
}

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
  version: number;
  updatedAt: string;
}

export interface LocalVaultRecord {
  userId: string;
  email: string;
  salt: string;
  kdf: KdfParams;
  payload: EncryptedPayload;
  syncedVersion: number;
  dirty: boolean;
  authRotationPending?: boolean;
}

export interface KeyMaterial {
  encryptionKey: CryptoKey;
  authToken: string;
}

export interface ImportSummary {
  privateCount: number;
  workCount: number;
  skippedEdenred: number;
  mergedOtto: number;
  categories: Record<Area, string[]>;
}

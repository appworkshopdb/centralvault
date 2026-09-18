import type { Area, CustomField, ImportSummary, VaultData, VaultEntry } from "./types";

type AnyRecord = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nowIso(): string { return new Date().toISOString(); }
function normalize(value: string): string { return value.toLocaleLowerCase("de").replace(/[^a-z0-9äöüß]+/g, " ").trim(); }
function categoryName(value: unknown): string { return text(value) || "Ohne Kategorie"; }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function newField(name: string, value: string, concealed = false): CustomField {
  return { id: crypto.randomUUID(), name, value, concealed };
}

function entryBase(area: Area, category: string, title: string, sourceCreated?: string, sourceUpdated?: string): VaultEntry {
  const timestamp = nowIso();
  return {
    id: crypto.randomUUID(), area, category, title: title || "Ohne Titel", username: "", password: "",
    urls: [], notes: "", fields: [], favorite: false,
    createdAt: sourceCreated || timestamp, updatedAt: sourceUpdated || timestamp,
  };
}

function shouldSkip(title: string): boolean { return normalize(title).includes("edenred"); }

export function importBitwarden(raw: unknown): { entries: VaultEntry[]; skippedEdenred: number } {
  if (!raw || typeof raw !== "object") throw new Error("Der Bitwarden-Export ist ungültig.");
  const data = raw as AnyRecord;
  const folders = new Map<string, string>();
  for (const folder of Array.isArray(data.folders) ? data.folders as AnyRecord[] : []) {
    folders.set(text(folder.id), categoryName(folder.name));
  }
  const entries: VaultEntry[] = [];
  let skippedEdenred = 0;
  for (const item of Array.isArray(data.items) ? data.items as AnyRecord[] : []) {
    const title = text(item.name);
    if (shouldSkip(title)) { skippedEdenred += 1; continue; }
    const entry = entryBase(
      "private",
      folders.get(text(item.folderId)) || "Ohne Kategorie",
      title,
      text(item.creationDate),
      text(item.revisionDate),
    );
    entry.favorite = item.favorite === true;
    entry.notes = text(item.notes);
    const login = item.login && typeof item.login === "object" ? item.login as AnyRecord : null;
    if (login) {
      entry.username = text(login.username);
      entry.password = text(login.password);
      const uris = Array.isArray(login.uris) ? login.uris as AnyRecord[] : [];
      entry.urls = unique(uris.map((uri) => text(uri.uri)));
      const totp = text(login.totp);
      if (totp) entry.fields.push(newField("TOTP-Geheimnis", totp, true));
    }
    const card = item.card && typeof item.card === "object" ? item.card as AnyRecord : null;
    if (card) {
      const cardFields: Array<[string, string, boolean?]> = [
        ["Karteninhaber", text(card.cardholderName)], ["Kartentyp", text(card.brand)],
        ["Kartennummer", text(card.number), true], ["Ablaufmonat", text(card.expMonth)],
        ["Ablaufjahr", text(card.expYear)], ["Prüfziffer", text(card.code), true],
      ];
      entry.fields.push(...cardFields.filter(([, value]) => value).map(([name, value, concealed]) => newField(name, value, concealed)));
    }
    const custom = Array.isArray(item.fields) ? item.fields as AnyRecord[] : [];
    entry.fields.push(...custom.map((field) => newField(text(field.name) || "Feld", text(field.value), Number(field.type) === 1)));
    entries.push(entry);
  }
  return { entries, skippedEdenred };
}

export function importWorkVault(raw: unknown): { entries: VaultEntry[]; skippedEdenred: number } {
  if (!Array.isArray(raw)) throw new Error("Der Arbeits-Vault-Export ist ungültig.");
  const entries: VaultEntry[] = [];
  let skippedEdenred = 0;
  for (const source of raw as AnyRecord[]) {
    const title = text(source.title);
    if (shouldSkip(title)) { skippedEdenred += 1; continue; }
    const entry = entryBase("work", categoryName(source.cat), title);
    entry.username = text(source.user);
    entry.password = text(source.pass);
    entry.notes = text(source.note);
    const directUrl = text(source.url);
    const host = text(source.host);
    entry.urls = unique([directUrl]);
    const supplemental: Array<[string, string]> = [["Host", host], ["IP", text(source.ip)], ["Port", text(source.port)]];
    entry.fields.push(...supplemental.filter(([, value]) => value).map(([name, value]) => newField(name, value)));
    entries.push(entry);
  }
  return { entries, skippedEdenred };
}

function mergeConfirmedOtto(entries: VaultEntry[]): { entries: VaultEntry[]; merged: number } {
  const privateIndex = entries.findIndex((entry) => entry.area === "private" && normalize(entry.title) === "otto partner");
  const workIndex = entries.findIndex((entry) => entry.area === "work" && ["otto portal", "otto partner"].includes(normalize(entry.title)));
  if (privateIndex < 0 || workIndex < 0) return { entries, merged: 0 };
  const privateEntry = entries[privateIndex]!;
  const workEntry = entries[workIndex]!;
  const merged: VaultEntry = {
    ...workEntry,
    title: "Otto Partner",
    username: workEntry.username || privateEntry.username,
    password: workEntry.password || privateEntry.password,
    urls: unique([...workEntry.urls, ...privateEntry.urls]),
    notes: unique([workEntry.notes, privateEntry.notes]).join("\n\n"),
    fields: [...workEntry.fields, ...privateEntry.fields],
    favorite: workEntry.favorite || privateEntry.favorite,
    createdAt: [workEntry.createdAt, privateEntry.createdAt].sort()[0]!,
    updatedAt: nowIso(),
  };
  return { entries: entries.filter((_, index) => index !== privateIndex && index !== workIndex).concat(merged), merged: 1 };
}

export function buildInitialVault(bitwardenRaw: unknown, workRaw: unknown): { vault: VaultData; summary: ImportSummary } {
  const personal = importBitwarden(bitwardenRaw);
  const work = importWorkVault(workRaw);
  const result = mergeConfirmedOtto([...personal.entries, ...work.entries]);
  const categories: Record<Area, string[]> = {
    private: unique(result.entries.filter((entry) => entry.area === "private").map((entry) => entry.category)).sort((a, b) => a.localeCompare(b, "de")),
    work: unique(result.entries.filter((entry) => entry.area === "work").map((entry) => entry.category)).sort((a, b) => a.localeCompare(b, "de")),
  };
  const timestamp = nowIso();
  const vault: VaultData = {
    schemaVersion: 1,
    name: "Central Vault",
    categories,
    entries: result.entries,
    deletedEntries: {},
    settings: { autoLockMinutes: 5, clipboardSeconds: 30 },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    vault,
    summary: {
      privateCount: result.entries.filter((entry) => entry.area === "private").length,
      workCount: result.entries.filter((entry) => entry.area === "work").length,
      skippedEdenred: personal.skippedEdenred + work.skippedEdenred,
      mergedOtto: result.merged,
      categories,
    },
  };
}

export function createEmptyVault(): VaultData {
  const timestamp = nowIso();
  return {
    schemaVersion: 1, name: "Central Vault", categories: { private: [], work: [] }, entries: [], deletedEntries: {},
    settings: { autoLockMinutes: 5, clipboardSeconds: 30 }, createdAt: timestamp, updatedAt: timestamp,
  };
}

export function mergeVaults(local: VaultData, remote: VaultData): VaultData {
  const tombstones = { ...local.deletedEntries, ...remote.deletedEntries };
  for (const [id, timestamp] of Object.entries(local.deletedEntries)) {
    if (!tombstones[id] || timestamp > tombstones[id]!) tombstones[id] = timestamp;
  }
  const entries = new Map<string, VaultEntry>();
  for (const entry of [...local.entries, ...remote.entries]) {
    const existing = entries.get(entry.id);
    if (!existing || entry.updatedAt > existing.updatedAt) entries.set(entry.id, entry);
  }
  for (const [id, deletedAt] of Object.entries(tombstones)) {
    const entry = entries.get(id);
    if (entry && deletedAt >= entry.updatedAt) entries.delete(id);
  }
  return {
    ...remote,
    entries: [...entries.values()],
    deletedEntries: tombstones,
    categories: {
      private: unique([...local.categories.private, ...remote.categories.private]).sort((a, b) => a.localeCompare(b, "de")),
      work: unique([...local.categories.work, ...remote.categories.work]).sort((a, b) => a.localeCompare(b, "de")),
    },
    settings: local.updatedAt > remote.updatedAt ? local.settings : remote.settings,
    createdAt: [local.createdAt, remote.createdAt].sort()[0]!,
    updatedAt: [local.updatedAt, remote.updatedAt].sort().at(-1)!,
  };
}

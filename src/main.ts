import { createIcons, Copy, Eye, EyeOff, KeyRound, Lock, LogOut, Plus, RefreshCw, Search, Settings, ShieldCheck, Trash2, WandSparkles, X } from "lucide";
import "./styles.css";
import { DEFAULT_KDF, decryptVault, deriveKeyMaterial, deriveSaltFromEmail, encryptVault, randomBytes } from "./crypto";
import { buildInitialVault, createEmptyVault, mergeVaults } from "./importers";
import { clearLocalVault, loadLocalVault, saveLocalVault } from "./storage";
import { ConflictError, createRemoteVault, fetchRemoteVault, signIn, signOut, signUp, subscribeToRemoteChanges, updateRemoteVault } from "./sync";
import type { Area, KeyMaterial, LocalVaultRecord, VaultData, VaultEntry } from "./types";

// frame-ancestors greift nur als HTTP-Header, den GitHub Pages nicht setzen kann.
// Deshalb der Schutz hier: läuft die App in einem fremden Rahmen, zeigt sie nichts.
if (window.top !== window.self) {
  document.body.textContent = "Central Vault kann nicht in einem eingebetteten Rahmen ausgeführt werden.";
  throw new Error("Framing blockiert.");
}

const app = document.querySelector<HTMLDivElement>("#app")!;

let record: LocalVaultRecord | null = null;
let keys: KeyMaterial | null = null;
let vault: VaultData | null = null;
let activeArea: Area = "work";
let activeCategory = "all";
let query = "";
let syncMessage = "Gesperrt";
let lockTimer: number | undefined;
let clipboardTimer: number | undefined;
let stopRealtime: (() => void) | null = null;

const icons = { Copy, Eye, EyeOff, KeyRound, Lock, LogOut, Plus, RefreshCw, Search, Settings, ShieldCheck, Trash2, WandSparkles, X };

function mountIcons(): void {
  createIcons({ icons, attrs: { "stroke-width": 1.8 } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
}

function notify(message: string, kind: "ok" | "error" = "ok"): void {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

function setBusy(button: HTMLButtonElement | null, busy: boolean, label = "Wird verarbeitet …"): void {
  if (!button) return;
  if (busy) {
    button.dataset.original = button.innerHTML;
    button.innerHTML = `<span class="spinner"></span>${label}`;
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.original || button.innerHTML;
    button.disabled = false;
  }
}

async function readJsonFile(input: HTMLInputElement): Promise<unknown> {
  const file = input.files?.[0];
  if (!file) throw new Error(`Bitte „${input.dataset.label || "Export"}“ auswählen.`);
  if (file.size > 10 * 1024 * 1024) throw new Error("Die Importdatei ist unerwartet groß.");
  try { return JSON.parse(await file.text()) as unknown; }
  catch { throw new Error(`${input.dataset.label || "Die Datei"} ist kein gültiges JSON.`); }
}

function setupShell(content: string): void {
  app.innerHTML = `
    <main class="auth-shell">
      <section class="brand-panel">
        <div class="brand-mark"><i data-lucide="shield-check"></i></div>
        <p class="eyebrow">Central Vault</p>
        <h1>Ein Tresor.<br><span>Zwei Welten.</span></h1>
        <p class="brand-copy">Private und geschäftliche Zugänge, sauber getrennt und dennoch sicher an einer Stelle.</p>
        <div class="security-note"><i data-lucide="lock"></i><div><strong>Zero Knowledge</strong><span>Masterpasswort und Klartextdaten verlassen dieses Gerät nie.</span></div></div>
      </section>
      <section class="auth-panel">${content}</section>
    </main>`;
  mountIcons();
}

function renderFirstRun(tab: "new" | "connect" = "new"): void {
  setupShell(`
    <div class="auth-card wide">
      <div class="segmented">
        <button type="button" data-tab="new" class="${tab === "new" ? "active" : ""}">Neuen Tresor anlegen</button>
        <button type="button" data-tab="connect" class="${tab === "connect" ? "active" : ""}">Gerät verbinden</button>
      </div>
      ${tab === "new" ? `
        <div class="auth-heading"><p class="eyebrow">Ersteinrichtung</p><h2>Exporte sicher importieren</h2><p>Die Dateien werden nur in diesem Browser gelesen und sofort verschlüsselt.</p></div>
        <form id="create-form" class="form-stack">
          <div class="file-grid">
            <label class="file-drop"><span>Privat</span><strong>Bitwarden-Export</strong><small>JSON-Datei auswählen</small><input id="bitwarden-file" data-label="Bitwarden-Export" type="file" accept="application/json,.json" required></label>
            <label class="file-drop"><span>Arbeit</span><strong>Vault-Export</strong><small>JSON-Datei auswählen</small><input id="work-file" data-label="Vault-Export" type="file" accept="application/json,.json" required></label>
          </div>
          <label>E-Mail-Adresse<input id="email" type="email" autocomplete="username" placeholder="du@example.de" required></label>
          <div class="two-cols"><label>Masterpasswort<input id="master" type="password" minlength="12" autocomplete="new-password" required></label><label>Wiederholen<input id="master-confirm" type="password" minlength="12" autocomplete="new-password" required></label></div>
          <p class="form-hint">Mindestens 12 Zeichen. Das Passwort kann technisch nicht wiederhergestellt werden.</p>
          <button class="primary" type="submit"><i data-lucide="key-round"></i>Tresor erstellen und importieren</button>
        </form>` : `
        <div class="auth-heading"><p class="eyebrow">Weiteres Gerät</p><h2>Bestehenden Tresor verbinden</h2><p>E-Mail und Masterpasswort genügen.</p></div>
        <form id="connect-form" class="form-stack">
          <label>E-Mail-Adresse<input id="email" type="email" autocomplete="username" required></label>
          <label>Masterpasswort<input id="master" type="password" minlength="12" autocomplete="current-password" required></label>
          <button class="primary" type="submit"><i data-lucide="refresh-cw"></i>Verbinden und entsperren</button>
        </form>`}
    </div>`);

  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => button.addEventListener("click", () => renderFirstRun(button.dataset.tab as "new" | "connect")));
  document.querySelectorAll<HTMLInputElement>(".file-drop input").forEach((input) => input.addEventListener("change", () => {
    const label = input.closest(".file-drop");
    label?.classList.toggle("selected", Boolean(input.files?.length));
    const small = label?.querySelector("small");
    if (small && input.files?.[0]) small.textContent = input.files[0].name;
  }));
  document.querySelector<HTMLFormElement>("#create-form")?.addEventListener("submit", handleCreate);
  document.querySelector<HTMLFormElement>("#connect-form")?.addEventListener("submit", handleConnect);
  mountIcons();
}

async function handleCreate(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  setBusy(button, true, "Tresor wird verschlüsselt …");
  try {
    const master = form.querySelector<HTMLInputElement>("#master")!.value;
    const confirmation = form.querySelector<HTMLInputElement>("#master-confirm")!.value;
    if (master !== confirmation) throw new Error("Die Masterpasswörter stimmen nicht überein.");
    const email = form.querySelector<HTMLInputElement>("#email")!.value.trim().toLowerCase();
    const [bitwardenRaw, workRaw] = await Promise.all([
      readJsonFile(form.querySelector<HTMLInputElement>("#bitwarden-file")!),
      readJsonFile(form.querySelector<HTMLInputElement>("#work-file")!),
    ]);
    const imported = buildInitialVault(bitwardenRaw, workRaw);
    const salt = await deriveSaltFromEmail(email);
    const keyMaterial = await deriveKeyMaterial(master, salt, DEFAULT_KDF);
    const userId = await signUp(email, keyMaterial.authToken);
    const payload = await encryptVault(imported.vault, keyMaterial.encryptionKey, userId, 1);
    await createRemoteVault(userId, salt, DEFAULT_KDF, payload);
    const next: LocalVaultRecord = { userId, email, salt, kdf: DEFAULT_KDF, payload, syncedVersion: 1, dirty: false };
    record = next;
    keys = keyMaterial;
    vault = imported.vault;
    await saveLocalVault(next);
    syncMessage = "Synchronisiert";
    startLockTimer();
    startRealtime();
    renderVault();
    notify(`${imported.summary.privateCount} private und ${imported.summary.workCount} geschäftliche Einträge importiert. Edenred entfernt, Otto zusammengeführt.`);
  } catch (error) {
    notify(error instanceof Error ? error.message : "Einrichtung fehlgeschlagen.", "error");
    setBusy(button, false);
  }
}

async function handleConnect(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  setBusy(button, true, "Tresor wird geladen …");
  try {
    const email = form.querySelector<HTMLInputElement>("#email")!.value.trim().toLowerCase();
    const master = form.querySelector<HTMLInputElement>("#master")!.value;
    const salt = await deriveSaltFromEmail(email);
    const keyMaterial = await deriveKeyMaterial(master, salt, DEFAULT_KDF);
    const userId = await signIn(email, keyMaterial.authToken);
    const payload = await fetchRemoteVault(userId);
    if (!payload) throw new Error("Zu diesem Konto existiert noch kein Tresor.");
    const data = await decryptVault(payload, keyMaterial.encryptionKey, userId);
    const next: LocalVaultRecord = { userId, email, salt, kdf: DEFAULT_KDF, payload, syncedVersion: payload.version, dirty: false };
    record = next;
    keys = keyMaterial;
    vault = data;
    await saveLocalVault(next);
    syncMessage = "Synchronisiert";
    startLockTimer();
    startRealtime();
    renderVault();
  } catch (error) {
    notify(error instanceof Error ? error.message : "Verbindung fehlgeschlagen.", "error");
    setBusy(button, false);
  }
}

function renderUnlock(): void {
  setupShell(`
    <div class="auth-card compact">
      <div class="auth-heading"><div class="round-icon"><i data-lucide="lock"></i></div><p class="eyebrow">Willkommen zurück</p><h2>Tresor entsperren</h2><p>Dein Masterpasswort bleibt ausschließlich auf diesem Gerät.</p></div>
      <form id="unlock-form" class="form-stack">
        <label>Masterpasswort<div class="input-action"><input id="master" type="password" minlength="12" autocomplete="current-password" autofocus required><button type="button" data-toggle-password aria-label="Passwort anzeigen"><i data-lucide="eye"></i></button></div></label>
        <button class="primary" type="submit"><i data-lucide="key-round"></i>Entsperren</button>
      </form>
      <button class="text-button danger-text" id="disconnect-device" type="button">Dieses Gerät trennen</button>
    </div>`);
  document.querySelector("[data-toggle-password]")?.addEventListener("click", togglePasswordInput);
  document.querySelector<HTMLFormElement>("#unlock-form")?.addEventListener("submit", handleUnlock);
  document.querySelector("#disconnect-device")?.addEventListener("click", disconnectDevice);
  mountIcons();
}

async function handleUnlock(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!record) return;
  const current = record;
  const form = event.currentTarget as HTMLFormElement;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  setBusy(button, true, "Wird entschlüsselt …");
  try {
    const master = form.querySelector<HTMLInputElement>("#master")!.value;
    keys = await deriveKeyMaterial(master, current.salt, current.kdf);
    // Zuerst lokal entschlüsseln: erkennt ein falsches Masterpasswort ohne Netz
    // und hält die App offline benutzbar.
    vault = await decryptVault(current.payload, keys.encryptionKey, current.userId);
    try {
      await signIn(current.email, keys.authToken);
      await reconcileRemote();
      startRealtime();
      syncMessage = current.dirty ? "Offline gespeichert" : "Synchronisiert";
    } catch {
      syncMessage = "Offline";
    }
    startLockTimer();
    renderVault();
  } catch (error) {
    keys = null; vault = null;
    notify(error instanceof Error ? error.message : "Entsperren fehlgeschlagen.", "error");
    setBusy(button, false);
  }
}

async function reconcileRemote(): Promise<void> {
  if (!record || !keys || !vault) return;
  const current = record;
  try {
    const remotePayload = await fetchRemoteVault(current.userId);
    if (!remotePayload) return;
    if (current.dirty) {
      if (remotePayload.version !== current.syncedVersion) {
        const remoteData = await decryptVault(remotePayload, keys.encryptionKey, current.userId);
        vault = mergeVaults(vault, remoteData);
        current.syncedVersion = remotePayload.version;
      }
      await pushCurrentVault();
    } else if (remotePayload.version > current.payload.version) {
      vault = await decryptVault(remotePayload, keys.encryptionKey, current.userId);
      current.payload = remotePayload;
      current.syncedVersion = remotePayload.version;
      await saveLocalVault(current);
    }
  } catch (error) {
    if (error instanceof Error && /falsch|beschädigt/i.test(error.message)) throw error;
    syncMessage = "Offline";
  }
}

function startRealtime(): void {
  stopRealtime?.();
  stopRealtime = record ? subscribeToRemoteChanges(record.userId, () => void pullIfNewer()) : null;
}

/** Reaktion auf ein Realtime-Signal: Daten immer frisch per select holen. */
async function pullIfNewer(): Promise<void> {
  if (!record || !keys || !vault || record.dirty) return;
  const current = record;
  try {
    const remote = await fetchRemoteVault(current.userId);
    if (!remote || remote.version <= current.syncedVersion) return;
    const remoteData = await decryptVault(remote, keys.encryptionKey, current.userId);
    vault = mergeVaults(vault, remoteData);
    current.payload = remote;
    current.syncedVersion = remote.version;
    await saveLocalVault(current);
    syncMessage = "Synchronisiert";
    renderVault();
    notify("Änderungen von einem anderen Gerät übernommen.");
  } catch {
    /* still scheitern – der nächste reguläre Sync holt es nach */
  }
}

function renderVault(): void {
  if (!vault || !record) return;
  const categories = vault.categories[activeArea];
  const filtered = vault.entries
    .filter((entry) => entry.area === activeArea)
    .filter((entry) => activeCategory === "all" || entry.category === activeCategory)
    .filter((entry) => !query || [entry.title, entry.username, entry.category, ...entry.urls].join(" ").toLocaleLowerCase("de").includes(query.toLocaleLowerCase("de")))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.title.localeCompare(b.title, "de"));
  const areaCount = (area: Area) => vault!.entries.filter((entry) => entry.area === area).length;
  app.innerHTML = `
    <div class="vault-shell">
      <aside class="sidebar">
        <div class="sidebar-brand"><span class="brand-mark small"><i data-lucide="shield-check"></i></span><strong>Central Vault</strong></div>
        <nav class="area-nav" aria-label="Bereiche">
          <button class="${activeArea === "work" ? "active" : ""}" data-area="work"><span class="area-dot work"></span><span>Arbeit</span><b>${areaCount("work")}</b></button>
          <button class="${activeArea === "private" ? "active" : ""}" data-area="private"><span class="area-dot private"></span><span>Privat</span><b>${areaCount("private")}</b></button>
        </nav>
        <div class="category-head"><span>Kategorien</span></div>
        <nav class="category-nav">
          <button class="${activeCategory === "all" ? "active" : ""}" data-category="all"><span>Alle Einträge</span><b>${areaCount(activeArea)}</b></button>
          ${categories.map((category) => `<button class="${activeCategory === category ? "active" : ""}" data-category="${escapeHtml(category)}"><span>${escapeHtml(category)}</span><b>${vault!.entries.filter((entry) => entry.area === activeArea && entry.category === category).length}</b></button>`).join("")}
        </nav>
        <div class="sidebar-bottom">
          <button id="settings"><i data-lucide="settings"></i>Einstellungen</button>
          <button id="lock"><i data-lucide="log-out"></i>Sperren</button>
        </div>
      </aside>
      <main class="content">
        <header class="topbar">
          <button class="mobile-brand" id="mobile-menu"><i data-lucide="shield-check"></i></button>
          <div class="search"><i data-lucide="search"></i><input id="search" value="${escapeHtml(query)}" placeholder="Zugänge durchsuchen …" autocomplete="off"><kbd>⌘ K</kbd></div>
          <div class="sync-state ${record.dirty ? "pending" : ""}"><span></span>${escapeHtml(syncMessage)}</div>
          <button class="primary small-button" id="add-entry"><i data-lucide="plus"></i>Neuer Zugang</button>
        </header>
        <section class="vault-content">
          <div class="content-head"><div><p class="eyebrow">${activeArea === "work" ? "Geschäftlich" : "Persönlich"}</p><h1>${activeCategory === "all" ? (activeArea === "work" ? "Arbeit" : "Privat") : escapeHtml(activeCategory)}</h1></div><p>${filtered.length} ${filtered.length === 1 ? "Eintrag" : "Einträge"}</p></div>
          <div class="entry-grid">
            ${filtered.length ? filtered.map(entryCard).join("") : `<div class="empty"><div class="round-icon"><i data-lucide="key-round"></i></div><h3>Keine Zugänge gefunden</h3><p>Lege einen neuen Zugang an oder ändere den Filter.</p></div>`}
          </div>
        </section>
      </main>
    </div>`;
  wireVaultEvents();
  mountIcons();
}

function entryCard(entry: VaultEntry): string {
  const initial = escapeHtml(entry.title.trim().charAt(0).toUpperCase() || "?");
  const primaryUrl = entry.urls[0] ? safeHostname(entry.urls[0]) : "Kein Link";
  return `<article class="entry-card" data-entry-id="${entry.id}" tabindex="0">
    <div class="entry-icon area-${entry.area}">${initial}</div>
    <div class="entry-main"><div class="entry-title">${escapeHtml(entry.title)}${entry.favorite ? " <span title=\"Favorit\">★</span>" : ""}</div><div class="entry-meta">${escapeHtml(entry.username || primaryUrl)}</div></div>
    <span class="category-pill">${escapeHtml(entry.category)}</span>
    <button class="icon-button" data-copy-entry="${entry.id}" aria-label="Passwort kopieren"><i data-lucide="copy"></i></button>
  </article>`;
}

function safeHostname(value: string): string {
  try { return new URL(value.includes("://") ? value : `https://${value}`).hostname || value; }
  catch { return value; }
}

function wireVaultEvents(): void {
  document.querySelector("#mobile-menu")?.addEventListener("click", () => document.querySelector(".sidebar")?.classList.toggle("open"));
  document.querySelectorAll<HTMLButtonElement>("[data-area]").forEach((button) => button.addEventListener("click", () => {
    activeArea = button.dataset.area as Area; activeCategory = "all"; renderVault();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-category]").forEach((button) => button.addEventListener("click", () => {
    activeCategory = button.dataset.category || "all"; renderVault();
  }));
  document.querySelector<HTMLInputElement>("#search")?.addEventListener("input", (event) => { query = (event.target as HTMLInputElement).value; renderVault(); document.querySelector<HTMLInputElement>("#search")?.focus(); });
  document.querySelector("#add-entry")?.addEventListener("click", () => openEntryEditor());
  document.querySelector("#settings")?.addEventListener("click", openSettings);
  document.querySelector("#lock")?.addEventListener("click", lockVault);
  document.querySelectorAll<HTMLElement>("[data-entry-id]").forEach((card) => {
    card.addEventListener("click", (event) => { if (!(event.target as HTMLElement).closest("[data-copy-entry]")) openEntryEditor(card.dataset.entryId); });
    card.addEventListener("keydown", (event) => { if (event.key === "Enter") openEntryEditor(card.dataset.entryId); });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-copy-entry]").forEach((button) => button.addEventListener("click", async () => {
    const entry = vault?.entries.find((item) => item.id === button.dataset.copyEntry);
    if (entry?.password) await copySecret(entry.password, "Passwort kopiert."); else notify("Für diesen Eintrag ist kein Passwort gespeichert.", "error");
  }));
}

function openEntryEditor(entryId?: string): void {
  if (!vault) return;
  const entry = entryId ? vault.entries.find((item) => item.id === entryId) : undefined;
  const area = entry?.area || activeArea;
  const fields = entry?.fields || [];
  openModal(`
    <form id="entry-form" class="modal-card editor" data-entry-id="${entry?.id || ""}">
      <div class="modal-head"><div><p class="eyebrow">${entry ? "Zugang bearbeiten" : "Neuer Zugang"}</p><h2>${entry ? escapeHtml(entry.title) : "Zugang anlegen"}</h2></div><button type="button" class="icon-button" data-close><i data-lucide="x"></i></button></div>
      <div class="form-grid">
        <label class="full">Bezeichnung<input name="title" value="${escapeHtml(entry?.title || "")}" required autofocus></label>
        <label>Bereich<select name="area"><option value="work" ${area === "work" ? "selected" : ""}>Arbeit</option><option value="private" ${area === "private" ? "selected" : ""}>Privat</option></select></label>
        <label>Kategorie<input name="category" value="${escapeHtml(entry?.category || "")}" list="category-list" required><datalist id="category-list">${vault.categories[area].map((category) => `<option value="${escapeHtml(category)}">`).join("")}</datalist></label>
        <label class="full">Benutzername<div class="input-action"><input name="username" value="${escapeHtml(entry?.username || "")}" autocomplete="off"><button type="button" data-copy-field="username"><i data-lucide="copy"></i></button></div></label>
        <label class="full">Passwort<div class="input-action"><input name="password" type="password" value="${escapeHtml(entry?.password || "")}" autocomplete="new-password"><button type="button" data-toggle-password><i data-lucide="eye"></i></button><button type="button" data-generate title="Sicheres Passwort erzeugen"><i data-lucide="wand-sparkles"></i></button><button type="button" data-copy-field="password"><i data-lucide="copy"></i></button></div></label>
        <label class="full">Webseiten <small>eine pro Zeile</small><textarea name="urls" rows="2">${escapeHtml((entry?.urls || []).join("\n"))}</textarea></label>
        <label class="full">Notizen<textarea name="notes" rows="4">${escapeHtml(entry?.notes || "")}</textarea></label>
      </div>
      <div class="custom-fields"><div class="section-title"><span>Zusätzliche Felder</span><button type="button" class="text-button" id="add-field">+ Feld hinzufügen</button></div><div id="field-list">${fields.map(fieldRow).join("")}</div></div>
      <label class="check"><input name="favorite" type="checkbox" ${entry?.favorite ? "checked" : ""}><span>Als Favorit markieren</span></label>
      <div class="modal-actions">${entry ? `<button type="button" class="danger-button" id="delete-entry"><i data-lucide="trash-2"></i>Löschen</button>` : ""}<span></span><button type="button" class="secondary" data-close>Abbrechen</button><button type="submit" class="primary">Speichern</button></div>
    </form>`);
  const form = document.querySelector<HTMLFormElement>("#entry-form")!;
  form.addEventListener("submit", saveEntry);
  form.querySelector("[data-toggle-password]")?.addEventListener("click", togglePasswordInput);
  form.querySelector("[data-generate]")?.addEventListener("click", () => {
    const input = form.elements.namedItem("password") as HTMLInputElement; input.value = generatePassword(); input.type = "text";
  });
  form.querySelectorAll<HTMLButtonElement>("[data-copy-field]").forEach((button) => button.addEventListener("click", async () => {
    const input = form.elements.namedItem(button.dataset.copyField!) as HTMLInputElement;
    if (input.value) await copySecret(input.value, "Kopiert.");
  }));
  form.querySelector("#add-field")?.addEventListener("click", () => {
    form.querySelector("#field-list")?.insertAdjacentHTML("beforeend", fieldRow()); wireFieldRemove(form);
  });
  form.querySelector("#delete-entry")?.addEventListener("click", () => deleteEntry(entry!.id));
  wireFieldRemove(form);
  mountIcons();
}

function fieldRow(field?: VaultEntry["fields"][number]): string {
  return `<div class="field-row" data-field-id="${field?.id || crypto.randomUUID()}"><input data-field-name placeholder="Name" value="${escapeHtml(field?.name || "")}"><input data-field-value placeholder="Wert" value="${escapeHtml(field?.value || "")}" type="${field?.concealed ? "password" : "text"}"><label class="mini-check" title="Verdeckt"><input data-field-concealed type="checkbox" ${field?.concealed ? "checked" : ""}>•••</label><button type="button" class="icon-button" data-remove-field><i data-lucide="x"></i></button></div>`;
}

function wireFieldRemove(form: HTMLFormElement): void {
  form.querySelectorAll<HTMLButtonElement>("[data-remove-field]").forEach((button) => button.onclick = () => button.closest(".field-row")?.remove());
  mountIcons();
}

async function saveEntry(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (!vault) return;
  const form = event.currentTarget as HTMLFormElement;
  const existing = vault.entries.find((entry) => entry.id === form.dataset.entryId);
  const data = new FormData(form);
  const timestamp = new Date().toISOString();
  const entry: VaultEntry = {
    id: existing?.id || crypto.randomUUID(),
    area: data.get("area") as Area,
    category: String(data.get("category") || "Ohne Kategorie").trim() || "Ohne Kategorie",
    title: String(data.get("title") || "").trim(),
    username: String(data.get("username") || ""),
    password: String(data.get("password") || ""),
    urls: String(data.get("urls") || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    notes: String(data.get("notes") || ""),
    favorite: data.get("favorite") === "on",
    fields: [...form.querySelectorAll<HTMLElement>(".field-row")].map((row) => ({
      id: row.dataset.fieldId || crypto.randomUUID(),
      name: row.querySelector<HTMLInputElement>("[data-field-name]")!.value.trim() || "Feld",
      value: row.querySelector<HTMLInputElement>("[data-field-value]")!.value,
      concealed: row.querySelector<HTMLInputElement>("[data-field-concealed]")!.checked,
    })).filter((field) => field.value || field.name !== "Feld"),
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
  vault.entries = existing ? vault.entries.map((item) => item.id === entry.id ? entry : item) : [...vault.entries, entry];
  if (!vault.categories[entry.area].includes(entry.category)) vault.categories[entry.area].push(entry.category);
  activeArea = entry.area; activeCategory = "all";
  closeModal(); renderVault(); await persistAndSync();
}

async function deleteEntry(id: string): Promise<void> {
  if (!vault || !confirm("Diesen Zugang wirklich löschen?")) return;
  const timestamp = new Date().toISOString();
  vault.entries = vault.entries.filter((entry) => entry.id !== id);
  vault.deletedEntries[id] = timestamp;
  closeModal(); renderVault(); await persistAndSync();
}

function openSettings(): void {
  if (!vault || !record) return;
  openModal(`<div class="modal-card settings-card">
    <div class="modal-head"><div><p class="eyebrow">Central Vault</p><h2>Einstellungen</h2></div><button type="button" class="icon-button" data-close><i data-lucide="x"></i></button></div>
    <div class="settings-section"><h3>Weiteres Gerät verbinden</h3><p>Auf dem anderen Gerät dieselbe Adresse öffnen und dort <strong>${escapeHtml(record.email)}</strong> samt Masterpasswort eingeben. Ein Verbindungslink wird nicht benötigt.</p></div>
    <form id="settings-form" class="settings-section form-grid">
      <label>Automatisch sperren<select name="autoLock"><option value="2" ${vault.settings.autoLockMinutes === 2 ? "selected" : ""}>nach 2 Minuten</option><option value="5" ${vault.settings.autoLockMinutes === 5 ? "selected" : ""}>nach 5 Minuten</option><option value="10" ${vault.settings.autoLockMinutes === 10 ? "selected" : ""}>nach 10 Minuten</option><option value="30" ${vault.settings.autoLockMinutes === 30 ? "selected" : ""}>nach 30 Minuten</option></select></label>
      <label>Zwischenablage leeren<select name="clipboard"><option value="15" ${vault.settings.clipboardSeconds === 15 ? "selected" : ""}>nach 15 Sekunden</option><option value="30" ${vault.settings.clipboardSeconds === 30 ? "selected" : ""}>nach 30 Sekunden</option><option value="60" ${vault.settings.clipboardSeconds === 60 ? "selected" : ""}>nach 60 Sekunden</option></select></label>
      <button class="primary full" type="submit">Einstellungen speichern</button>
    </form>
    <div class="settings-section"><h3>Verschlüsseltes Backup</h3><p>Das Backup enthält ausschließlich den verschlüsselten Tresor und die benötigten KDF-Parameter.</p><button class="secondary" id="download-backup">Backup herunterladen</button></div>
    <div class="settings-section danger-zone"><h3>Gerät trennen</h3><p>Entfernt nur die lokale Kopie. Der zentrale Tresor bleibt erhalten.</p><button class="danger-button" id="disconnect-device">Lokale Daten entfernen</button></div>
  </div>`);
  document.querySelector("#download-backup")?.addEventListener("click", downloadEncryptedBackup);
  document.querySelector("#disconnect-device")?.addEventListener("click", disconnectDevice);
  document.querySelector<HTMLFormElement>("#settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    vault!.settings.autoLockMinutes = Number(data.get("autoLock"));
    vault!.settings.clipboardSeconds = Number(data.get("clipboard"));
    closeModal(); startLockTimer(); await persistAndSync(); renderVault();
  });
  mountIcons();
}

function openModal(content: string): void {
  closeModal();
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = content;
  modal.addEventListener("mousedown", (event) => { if (event.target === modal) closeModal(); });
  modal.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
  document.body.append(modal);
  mountIcons();
}

function closeModal(): void { document.querySelector(".modal-backdrop")?.remove(); }

async function persistAndSync(): Promise<void> {
  if (!vault || !record || !keys) return;
  vault.updatedAt = new Date().toISOString();
  const nextVersion = record.syncedVersion + 1;
  record.payload = await encryptVault(vault, keys.encryptionKey, record.userId, nextVersion);
  record.dirty = true;
  syncMessage = "Wird synchronisiert …";
  await saveLocalVault(record);
  updateSyncIndicator();
  try {
    await pushCurrentVault();
    syncMessage = "Synchronisiert";
  } catch (error) {
    if (error instanceof ConflictError) {
      try {
        const remotePayload = await fetchRemoteVault(record.userId);
        if (!remotePayload) throw new Error("Tresor nicht gefunden.");
        const remoteData = await decryptVault(remotePayload, keys.encryptionKey, record.userId);
        vault = mergeVaults(vault, remoteData);
        record.syncedVersion = remotePayload.version;
        await pushCurrentVault();
        syncMessage = "Änderungen zusammengeführt";
        renderVault();
      } catch { syncMessage = "Offline gespeichert"; }
    } else { syncMessage = "Offline gespeichert"; }
  }
  updateSyncIndicator();
}

async function pushCurrentVault(): Promise<void> {
  if (!vault || !record || !keys) return;
  const nextVersion = record.syncedVersion + 1;
  record.payload = await encryptVault(vault, keys.encryptionKey, record.userId, nextVersion);
  record.dirty = true;
  await saveLocalVault(record);
  await updateRemoteVault(record.userId, record.syncedVersion, record.payload);
  record.syncedVersion = nextVersion;
  record.dirty = false;
  await saveLocalVault(record);
}

function updateSyncIndicator(): void {
  const element = document.querySelector<HTMLElement>(".sync-state");
  if (!element || !record) return;
  element.classList.toggle("pending", record.dirty);
  element.innerHTML = `<span></span>${escapeHtml(syncMessage)}`;
}

async function copySecret(value: string, message: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  notify(message);
  window.clearTimeout(clipboardTimer);
  clipboardTimer = window.setTimeout(async () => {
    try {
      const current = await navigator.clipboard.readText();
      if (current === value) await navigator.clipboard.writeText("");
    } catch { /* Browser may deny clipboard reads. */ }
  }, (vault?.settings.clipboardSeconds || 30) * 1000);
}

function generatePassword(length = 24): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-=?";
  const limit = 256 - (256 % alphabet.length);
  let result = "";
  while (result.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) if (byte < limit && result.length < length) result += alphabet[byte % alphabet.length];
  }
  return result;
}

function togglePasswordInput(event: Event): void {
  const button = event.currentTarget as HTMLButtonElement;
  const input = button.parentElement?.querySelector<HTMLInputElement>("input");
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
  button.innerHTML = `<i data-lucide="${input.type === "password" ? "eye" : "eye-off"}"></i>`;
  mountIcons();
}

function startLockTimer(): void {
  window.clearTimeout(lockTimer);
  if (!vault) return;
  lockTimer = window.setTimeout(lockVault, vault.settings.autoLockMinutes * 60_000);
}

function resetLockTimer(): void { if (vault && keys) startLockTimer(); }

function lockVault(): void {
  window.clearTimeout(lockTimer);
  stopRealtime?.();
  stopRealtime = null;
  void signOut();
  closeModal(); keys = null; vault = null; query = ""; activeCategory = "all"; syncMessage = "Gesperrt"; renderUnlock();
}

async function disconnectDevice(): Promise<void> {
  if (!confirm("Lokale Tresordaten von diesem Gerät entfernen? Der zentrale Tresor bleibt erhalten.")) return;
  stopRealtime?.();
  stopRealtime = null;
  await signOut();
  await clearLocalVault();
  record = null; keys = null; vault = null;
  history.replaceState(null, "", location.pathname);
  renderFirstRun();
}

function downloadEncryptedBackup(): void {
  if (!record) return;
  const backup = { format: "central-vault-backup", formatVersion: 2, userId: record.userId, email: record.email, salt: record.salt, kdf: record.kdf, payload: record.payload };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `central-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); URL.revokeObjectURL(link.href);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && vault) { event.preventDefault(); document.querySelector<HTMLInputElement>("#search")?.focus(); }
});
for (const eventName of ["pointerdown", "keydown", "touchstart"] as const) document.addEventListener(eventName, resetLockTimer, { passive: true });

async function init(): Promise<void> {
  record = await loadLocalVault();
  if (record) {
    record.syncedVersion ??= record.payload.version;
    renderUnlock();
  } else renderFirstRun();
  if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}

void init();

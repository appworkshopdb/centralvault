# Central Vault

Eine installierbare Passwortmanager-PWA für **Arbeit** und **Privat**. Die Oberfläche liegt auf GitHub Pages, Speicherung und Synchronisation laufen über **Supabase** (Postgres + Auth + Realtime). Supabase sieht ausschließlich Ende-zu-Ende-verschlüsselte Daten – kein Klartext, kein Masterpasswort, kein Schlüssel.

## Architektur

```
  Gerät A (PWA)                Supabase                   Gerät B (PWA)
  ─────────────                ────────                   ─────────────
  Masterpasswort                                          Masterpasswort
        │                                                       │
   Argon2id(Salt)                                          Argon2id(Salt)
        ├── Byte 0–31  → AES-256-GCM-Schlüssel  (bleibt im RAM des Geräts)
        └── Byte 32–63 → SHA-256 → Auth-Token   = Supabase-Auth-Passwort
        │                                                       │
   AES-256-GCM  ──►  HTTPS  ──►  Tabelle public.vaults  ◄──  HTTPS
        │                        (RLS: nur eigene Zeile)        │
   IndexedDB                     Realtime-Signal ───────────────┘
   (verschlüsselte Offline-Kopie)
```

Das Salt wird deterministisch aus der E-Mail abgeleitet (`SHA-256("central-vault-salt-v2:" + email)`), damit es vor der Anmeldung ohne Serverabfrage feststeht. Damit entfällt der frühere öffentliche `/meta`-Endpunkt ersatzlos.

## Was der Wechsel auf Supabase ändert

| Bereich | vorher | nachher |
| --- | --- | --- |
| Backend | Cloudflare Worker + D1 | Supabase Postgres, kein eigener Servercode |
| Zugriffsschutz | Bearer-Token, Hash in der Tabelle | Supabase Auth (JWT) + Row Level Security |
| Anmeldung | Tresor-ID + Masterpasswort | E-Mail + Masterpasswort |
| Zweites Gerät | Verbindungslink mit Tresor-ID | E-Mail + Masterpasswort eingeben |
| Salt | zufällig, serverseitig gespeichert | deterministisch aus der E-Mail |
| Konflikte | `expectedVersion` im PUT | `.eq('version', …)` + Postgres-Trigger |
| Aktualisierung | erst beim Entsperren | Realtime-Push in Sekunden |
| CORS | `ALLOWED_ORIGINS` im Worker | entfällt (Supabase erlaubt jeden Origin, RLS schützt) |
| Verzeichnis `worker/` | nötig | wird gelöscht |

Unverändert bleiben: Argon2id (64 MiB, 3 Iterationen), AES-256-GCM, die verschlüsselte IndexedDB-Kopie, die Merge-Logik über Änderungszeitpunkte und Löschmarkierungen sowie sämtliche Importregeln.

## Was bereits umgesetzt ist

- Argon2id-Schlüsselableitung (64 MiB, drei Iterationen) und AES-256-GCM
- lokale verschlüsselte Offline-Kopie in IndexedDB
- synchronisierte Bearbeitung auf mehreren Geräten
- konfliktarme Zusammenführung über Änderungszeitpunkte und Löschmarkierungen
- getrennte Bereiche Arbeit/Privat, Kategorien, Suche und Favoriten
- Erstellen, Bearbeiten, Löschen, Kopieren und Passwortgenerator
- automatische Sperre und bestmögliches Leeren der Zwischenablage
- PWA/Offline-App-Shell
- lokaler Erstimport beider gelieferten Exportformate

### Fest eingebaute Importregeln

- Bitwarden → **Privat**, Bitwarden-Ordner → Kategorie
- Vault Export → **Arbeit**, `cat` → Kategorie
- `Otto Partner` und `Otto Portal` werden einmalig zu **Otto Partner / Arbeit** vereinigt
- FTP Buntler/Snaptrade sowie Amazon/ACR bleiben getrennt
- alle Edenred-Einträge werden ausgelassen
- Klartextexporte werden weder hochgeladen noch dauerhaft im Browser gespeichert

---

# Fahrplan

## 0. Voraussetzungen

- Node.js 22 oder neuer
- ein Supabase-Konto (kostenloser Tarif reicht)
- ein leeres **privates** GitHub-Repository
- eine E-Mail-Adresse, auf deren Postfach du sicher zugreifst

## 1. Lokal prüfen

```bash
npm install
npm test
npm run dev
```

## 2. Supabase-Projekt anlegen

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
2. Name `central-vault`, Region **Central EU (Frankfurt)** – wegen DSGVO und Latenz.
3. Das Datenbankpasswort im bestehenden Passwortmanager ablegen. Es wird für den Betrieb der App nicht gebraucht, nur für direkte SQL-Zugriffe.
4. Unter **Project Settings → API** notieren:
   - **Project URL** → `https://<ref>.supabase.co`
   - **anon / publishable key** (je nach Dashboard-Version einer der beiden Namen)

Der anon-Key ist öffentlich und darf im Frontend-Build stehen. Der **service_role- bzw. secret-Key darf niemals** ins Repository oder in den Browser – er umgeht RLS vollständig.

## 3. Schema, RLS und Realtime einspielen

Im Dashboard **SQL Editor → New query** öffnen, den kompletten Inhalt von [`supabase/schema.sql`](supabase/schema.sql) einfügen und ausführen. Das Skript legt an:

- Tabelle `public.vaults`: eine Zeile pro Benutzer mit `salt`, `kdf`, `iv`, `ciphertext`, `version`
- CHECK-Constraints auf Base64-Format, Chiffratgröße (max. 2 MB) und KDF-Parameter
- RLS mit drei Policies (select/insert/update auf `auth.uid() = user_id`), **bewusst ohne delete**
- Trigger, die `version` streng um 1 erhöhen und `salt`, `kdf`, `created_at` unveränderlich machen
- Realtime-Publikation für `public.vaults`

Kontrolle direkt darunter ausführen:

```sql
select relrowsecurity from pg_class where oid = 'public.vaults'::regclass;  -- true
select policyname, cmd from pg_policies where tablename = 'vaults';        -- 3 Zeilen
```

Zusätzlich im Dashboard unter **Advisors → Security** prüfen, dass keine Warnung zu `public.vaults` offen ist.

## 4. Auth konfigurieren

Unter **Authentication → Providers / Sign In**:

1. **Email** aktivieren, alle anderen Provider deaktivieren.
2. **Confirm email** vorerst **aus** – sonst bricht der Ersteinrichtungs-Flow zwischen Registrierung und Import ab.
3. **Allow new users to sign up** vorerst **an**.
4. **Leaked password protection** (HaveIBeenPwned) **aus**: Das Auth-Passwort ist ein abgeleiteter Zufallswert; die Prüfung würde nur ein Hash-Präfix davon nach außen geben, ohne je zu treffen.
5. Unter **Sessions** die JWT-Laufzeit auf 1 Stunde setzen.

Nach Schritt 8 (Konto steht) gilt verbindlich:

- **Allow new users to sign up** auf **aus** stellen. Der anon-Key ist öffentlich – ohne diesen Schalter kann sich jeder ein Konto in deinem Projekt anlegen.
- **Confirm email** wieder **an**.

## 5. Frontend verdrahten

`.env.example` nach `.env` kopieren und füllen:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon/publishable key>
```

`.env` steht in `.gitignore` und bleibt dort. Die Werte landen im Build, nicht im Repository.

## 6. Code umbauen

Die Umstellung betrifft diese Dateien:

| Datei | Änderung |
| --- | --- |
| `worker/` | komplett löschen, inkl. `wrangler.toml.example` |
| `package.json` | `@supabase/supabase-js` ergänzen |
| `supabase/schema.sql` | neu (liegt bei) |
| `src/supabase.ts` | neu: Client mit `persistSession: false` |
| `src/sync.ts` | neu gegen Supabase: `signUp`, `signIn`, `signOut`, `createRemoteVault`, `fetchRemoteVault`, `updateRemoteVault`, `subscribeToRemoteChanges`, `ConflictError` |
| `src/crypto.ts` | `deriveSaltFromEmail()` ergänzen, Rest unverändert |
| `src/types.ts` | `LocalVaultRecord`: `apiUrl`/`vaultId` → `email`/`userId` |
| `src/main.ts` | Formulare (E-Mail statt Sync-API/Tresor-ID), Create/Connect/Unlock, Realtime-Abo, Masterpasswort-Wechsel, Einstellungen |
| `public/sw.js` | alle fremden Origins vom Cache ausnehmen, Cache-Name auf `v2` |
| `index.html` / `vite.config.ts` | CSP auf die konkrete Supabase-Domain (`https:` **und** `wss:`) einengen |
| `.github/workflows/deploy-pages.yml` | Build-Variablen austauschen |
| `.env.example`, `SECURITY.md` | Text nachziehen |

Fachlich sind dabei vier Punkte entscheidend:

**Anmeldung.** `deriveKeyMaterial()` liefert weiterhin Schlüssel *und* Auth-Token. Das Auth-Token ist jetzt das Supabase-Passwort: `supabase.auth.signInWithPassword({ email, password: authToken })`. Supabase erhält damit nie das Masterpasswort, sondern nur einen daraus abgeleiteten, domänengetrennten Wert – und speichert davon ohnehin nur einen bcrypt-Hash.

**Sitzung.** Der Client läuft mit `persistSession: false`. Die Sitzung lebt im RAM, die automatische Sperre beendet sie, und es liegt kein Refresh-Token in `localStorage`. Preis: Jedes Entsperren braucht eine Netzverbindung. Offline wird deshalb wie bisher aus der IndexedDB entschlüsselt und der Push in die Warteschlange gestellt.

**Konflikte.** Statt `expectedVersion` im PUT:

```ts
const { data } = await supabase
  .from("vaults")
  .update({ iv, ciphertext, version: expectedVersion + 1, client_updated_at })
  .eq("user_id", userId)
  .eq("version", expectedVersion)
  .select("version")
  .maybeSingle();
if (!data) throw new ConflictError();
```

Die bestehende Merge-Logik in `persistAndSync()` bleibt dadurch unverändert gültig.

**Realtime.** Das Abo dient nur als Signal; die Daten werden danach per `select` geholt, weil `postgres_changes` bei Nutzlasten über etwa 1 MB abbricht:

```ts
supabase.channel("vault")
  .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "vaults", filter: `user_id=eq.${userId}` },
      () => void pullIfNewer())
  .subscribe();
```

**Masterpasswort wechseln** (neu, weil Auth-Passwort und Vault-Schlüssel gemeinsam rotieren müssen): Tresor mit dem neuen Schlüssel neu verschlüsseln und mit `version + 1` schreiben, danach `supabase.auth.updateUser({ password: neuesAuthToken })`. Scheitert der zweite Schritt, muss die App das im lokalen Datensatz vermerken und beim nächsten Entsperren zur Reparatur auffordern – sonst passen Anmeldung und Chiffrat nicht mehr zusammen.

## 7. GitHub Pages aktivieren

1. Den Projektordner in ein **neues privates GitHub-Repository** übertragen. Die beiden Klartext-Exporte gehören nicht hinein.
2. Unter **Settings → Secrets and variables → Actions → Variables** anlegen:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   
   (Variables, nicht Secrets: Beide Werte sind öffentlich, und maskierte Secrets erschweren nur die Fehlersuche im Build-Log.)
3. Unter **Settings → Pages → Build and deployment** als Quelle **GitHub Actions** auswählen.
4. Auf `main` pushen. Der beiliegende Workflow testet, baut und veröffentlicht.

Eine Nachpflege der erlaubten Origins wie früher bei Cloudflare entfällt – RLS ersetzt die CORS-Liste.

## 8. Tresor einrichten

1. GitHub-Pages-Adresse öffnen.
2. E-Mail-Adresse eintragen, Bitwarden-JSON als **Privat** und `Vault_Export.json` als **Arbeit** auswählen.
3. Ein starkes, neues Masterpasswort mit mindestens 12 Zeichen festlegen.
4. Die App registriert das Konto, meldet an, importiert lokal, verschlüsselt und schreibt genau eine Zeile nach Supabase.
5. Kontrolle im Dashboard unter **Table Editor → vaults**: eine Zeile, `ciphertext` unlesbar, `version = 1`.
6. Jetzt **Allow new users to sign up** ausschalten und **Confirm email** wieder einschalten (Schritt 4).
7. In den Einstellungen sofort ein verschlüsseltes Backup herunterladen.

Das Masterpasswort ist nicht wiederherstellbar. „Passwort vergessen“ in Supabase setzt nur die Anmeldung zurück, nicht den Schlüssel – der Tresor bliebe unlesbar. Deshalb das Masterpasswort außerhalb dieses Tresors sicher hinterlegen.

## 9. Zweites Gerät

1. Dieselbe Pages-Adresse öffnen.
2. E-Mail und Masterpasswort eingeben, mehr nicht. Ein Verbindungslink wird nicht mehr gebraucht.
3. Zum Startbildschirm hinzufügen.

Änderungen erscheinen ab jetzt über Realtime auf dem jeweils anderen Gerät, ohne dass die App neu geladen werden muss.

## 10. Betrieb

- **Backups:** Der kostenlose Supabase-Tarif sichert täglich, aber ohne Point-in-Time-Recovery. Die verschlüsselten Backups aus der App bleiben deshalb die verlässliche Sicherung – regelmäßig herunterladen.
- **Ruhemodus:** Kostenlose Projekte pausieren nach sieben Tagen ohne Zugriff. Bei täglicher Nutzung kein Thema; nach einem längeren Urlaub das Projekt im Dashboard wieder starten, bevor du dich wunderst.
- **Supabase-Konto mit MFA absichern.** Wer dort hineinkommt, bekommt zwar nur Chiffrat, kann es aber löschen.
- GitHub-Konto ebenfalls mit MFA absichern; ein manipulierter Pages-Build ist der schwerwiegendste Angriffsweg dieser Architektur.
- `npm audit` und die GitHub Actions regelmäßig aktualisieren.

---

## Wechsel von einer bestehenden Cloudflare-Installation

Salt und AAD hängen jetzt an der E-Mail beziehungsweise an der Supabase-Benutzer-ID. Ein altes Chiffrat lässt sich deshalb nicht einfach hochladen; es muss einmal umgeschlüsselt werden.

1. Auf dem alten Stand ein verschlüsseltes Backup herunterladen. Es enthält `vaultId`, `salt`, `kdf` und den Payload – alles, was zum Entschlüsseln nötig ist.
2. Die neue App über **„Backup wiederherstellen“** starten: Masterpasswort abfragen, mit **Salt und vaultId aus der Backup-Datei** entschlüsseln.
3. Konto in Supabase anlegen, mit dem E-Mail-Salt neu ableiten, mit der neuen `userId` als AAD neu verschlüsseln und als `version = 1` schreiben.
4. Erst danach D1-Datenbank und Worker löschen.

Wer noch nichts produktiv nutzt, überspringt das und beginnt bei Schritt 8 neu.

## Sicherheitsmodell

Details in [SECURITY.md](SECURITY.md). Kurzfassung der Supabase-spezifischen Punkte:

- Supabase speichert Salt, öffentliche KDF-Parameter, Nonce und Chiffrat. Ein Datenbankleck gibt ohne Masterpasswort nichts preis.
- Der JWT ist ausschließlich eine Abholberechtigung für das Chiffrat, kein Schlüssel.
- Das deterministische Salt ist an die E-Mail gebunden. Das ist schwächer als ein zufälliges Salt pro Konto, aber durch die Domänentrennung und die Einzigartigkeit der Adresse praktisch gleichwertig – und es ist der Preis dafür, dass vor der Anmeldung keine öffentliche Abfrage mehr nötig ist.
- Die fehlende delete-Policy verhindert versehentliches wie böswilliges Löschen über die API.
- Der service_role-Key gehört ausschließlich ins Dashboard, niemals in Repository, Build oder Browser.

## Wichtiger Sicherheitshinweis

Die Originalexporte sind unverschlüsselte Klartextdateien. Nach erfolgreichem Import aus Downloads, Backups und Papierkorb entfernen.

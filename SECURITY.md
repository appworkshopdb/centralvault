# Sicherheitsmodell

Central Vault ist als **Zero-Knowledge-Anwendung** aufgebaut:

- Das Masterpasswort wird nie gespeichert oder an die Sync-API gesendet.
- Argon2id leitet im Browser zwei getrennte Schlüsselanteile ab.
- Tresordaten werden mit AES-256-GCM und einem zufälligen Nonce verschlüsselt.
- Die Sync-API speichert nur Salt, öffentliche KDF-Parameter, verschlüsselten Blob und einen Hash des abgeleiteten Auth-Tokens.
- IndexedDB enthält ebenfalls nur den verschlüsselten Blob.
- Der GitHub-Pages-Build enthält keine Zugangsdaten und keine Exportdateien.

## Grenzen

Dieses Projekt ist nicht extern auditiert. Ein kompromittiertes Endgerät, schädliche Browser-Erweiterungen, XSS durch eine manipulierte Auslieferung oder ein schwaches Masterpasswort können Geheimnisse gefährden. Für besonders kritische Zugänge sollten zusätzlich Passkeys oder MFA aktiviert sein.

## Betrieb

- GitHub Actions und Abhängigkeiten regelmäßig aktualisieren.
- GitHub-Konto und Cloudflare-Konto mit MFA absichern.
- Ausschließlich HTTPS verwenden.
- D1-Backups aktivieren und regelmäßig verschlüsselte Tresor-Backups herunterladen.
- Niemals Bitwarden-/Vault-Klartextexporte in Git committen.
- Die ursprünglichen Exporte nach erfolgreicher Migration aus Download- und Papierkorb-Ordnern entfernen.

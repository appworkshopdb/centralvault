import { supabase } from "./supabase";
import type { EncryptedPayload, KdfParams } from "./types";

export class ConflictError extends Error {
  constructor() {
    super("Der Tresor wurde auf einem anderen Gerät geändert.");
  }
}

interface VaultRow {
  user_id: string;
  salt: string;
  kdf: KdfParams;
  iv: string;
  ciphertext: string;
  version: number;
  client_updated_at: string;
}

function toPayload(row: VaultRow): EncryptedPayload {
  return {
    iv: row.iv,
    ciphertext: row.ciphertext,
    version: row.version,
    updatedAt: new Date(row.client_updated_at).toISOString(),
  };
}

/* ---------------------------------------------------------------- Anmeldung */

/** Legt das Konto an. Das Passwort ist das aus Argon2id abgeleitete Auth-Token. */
export async function signUp(email: string, authToken: string): Promise<string> {
  const { data, error } = await supabase.auth.signUp({ email, password: authToken });
  if (error) throw new Error(`Registrierung fehlgeschlagen: ${error.message}`);
  if (!data.session) {
    throw new Error(
      "Supabase verlangt eine E-Mail-Bestätigung. Unter Authentication → Sign In / Providers → User Signups „Confirm email\" abschalten.",
    );
  }
  return data.user!.id;
}

export async function signIn(email: string, authToken: string): Promise<string> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: authToken,
  });
  if (error) throw new Error("Anmeldung fehlgeschlagen: E-Mail oder Masterpasswort falsch.");
  return data.user!.id;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Rotiert das Auth-Passwort beim Wechsel des Masterpassworts. */
export async function changeAuthPassword(newAuthToken: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newAuthToken });
  if (error) throw new Error(`Auth-Passwort konnte nicht aktualisiert werden: ${error.message}`);
}

/* ------------------------------------------------------------------- Tresor */

export async function createRemoteVault(
  userId: string,
  salt: string,
  kdf: KdfParams,
  payload: EncryptedPayload,
): Promise<void> {
  const { error } = await supabase.from("vaults").insert({
    user_id: userId,
    salt,
    kdf,
    iv: payload.iv,
    ciphertext: payload.ciphertext,
    client_updated_at: payload.updatedAt,
  });
  if (error) {
    if (error.code === "23505") throw new Error("Zu diesem Konto existiert bereits ein Tresor.");
    throw new Error(`Tresor konnte nicht angelegt werden: ${error.message}`);
  }
}

/** Liefert null, wenn zum Konto noch kein Tresor existiert. */
export async function fetchRemoteVault(userId: string): Promise<EncryptedPayload | null> {
  const { data, error } = await supabase
    .from("vaults")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Tresor konnte nicht geladen werden: ${error.message}`);
  return data ? toPayload(data as VaultRow) : null;
}

/** Bedingtes Update. Kein Treffer bedeutet: ein anderes Gerät war schneller. */
export async function updateRemoteVault(
  userId: string,
  expectedVersion: number,
  payload: EncryptedPayload,
): Promise<void> {
  if (payload.version !== expectedVersion + 1) {
    throw new Error(
      `Interner Versionsfehler: erwartet ${expectedVersion + 1}, erhalten ${payload.version}.`,
    );
  }
  const { data, error } = await supabase
    .from("vaults")
    .update({
      iv: payload.iv,
      ciphertext: payload.ciphertext,
      version: payload.version,
      client_updated_at: payload.updatedAt,
    })
    .eq("user_id", userId)
    .eq("version", expectedVersion)
    .select("version")
    .maybeSingle();
  if (error) throw new Error(`Synchronisierung fehlgeschlagen: ${error.message}`);
  if (!data) throw new ConflictError();
}

/* ----------------------------------------------------------------- Realtime */

/**
 * Meldet Änderungen anderer Geräte. Die Nutzlast wird bewusst ignoriert:
 * postgres_changes bricht bei Datensätzen über ca. 1 MB ab, das Chiffrat
 * darf deshalb nie der Transportweg sein. Rückgabe: Abmelde-Funktion.
 */
export function subscribeToRemoteChanges(userId: string, onChange: () => void): () => void {
  const channel = supabase
    .channel(`vault:${userId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "vaults", filter: `user_id=eq.${userId}` },
      () => onChange(),
    )
    .subscribe();
  return () => void supabase.removeChannel(channel);
}

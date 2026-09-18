import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !key) {
  throw new Error(
    "VITE_SUPABASE_URL oder VITE_SUPABASE_ANON_KEY fehlt. " +
      "Lokal in .env eintragen, für den Build als GitHub-Actions-Variable setzen.",
  );
}

export const supabase = createClient(url, key, {
  auth: {
    // Sitzung lebt ausschließlich im RAM: kein Refresh-Token in localStorage,
    // die automatische Sperre beendet damit auch den Serverzugriff.
    persistSession: false,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
  global: {
    headers: { "X-Client-Info": "central-vault" },
  },
});

if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).supabase = supabase;

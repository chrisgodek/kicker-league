// Supabase client plus small helpers that turn { data, error } into return-or-throw.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function rows(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

export async function currentUser() {
  const { data } = await sb.auth.getSession();
  return data.session?.user ?? null;
}

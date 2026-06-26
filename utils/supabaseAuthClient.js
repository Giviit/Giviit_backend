const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// Calling auth.signInWithPassword() on a client mutates that client's session
// state — every subsequent .from() call on the SAME instance then runs as that
// user (subject to RLS) instead of whatever key it was created with. The shared
// service-role client in supabaseClient.js must never touch a sign-in method,
// so this creates a fresh, anon-keyed, non-persisting client per call instead.
function createAuthClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  }
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws },
  });
}

module.exports = { createAuthClient };

const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const dotenv = require('dotenv');

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
}

// Node < 22 has no native WebSocket global, which @supabase/realtime-js requires
// even though this backend never actually opens a realtime subscription.
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  realtime: { transport: ws },
});

module.exports = { supabase };

const { supabase } = require('./supabaseClient');

async function logAudit({ action, entityType, entityId, performedBy, metadata }) {
  try {
    await supabase.from('audit_logs').insert({
      action,
      entity_type: entityType,
      entity_id: entityId || null,
      performed_by: performedBy || null,
      metadata: metadata || null,
    });
  } catch {}
}

module.exports = { logAudit };

const { supabase } = require('../utils/supabaseClient');
const { logAudit } = require('../utils/auditLog');

// Runs every 5 minutes (see node-cron job in server.js). A donation's
// payment_expires_at is set at creation time in donationController —
// 30 minutes out for bank_transfer, 24h for card/USSD — so a single query
// covers both windows.
async function expireStalePayments() {
  const nowIso = new Date().toISOString();
  const { data: expired, error } = await supabase
    .from('donations')
    .update({ paystack_status: 'expired' })
    .eq('paystack_status', 'pending')
    .lt('payment_expires_at', nowIso)
    .select('id, campaign_id, payment_channel, paystack_reference');

  if (error) {
    console.error('[paymentExpiry] Failed to expire stale donations:', error.message);
    return;
  }
  if (!expired?.length) return;

  for (const d of expired) {
    await logAudit({
      action: 'DONATION_EXPIRED',
      entityType: 'donation',
      entityId: d.id,
      metadata: { campaign_id: d.campaign_id, payment_channel: d.payment_channel, paystack_reference: d.paystack_reference },
    });
  }

  console.log(`[paymentExpiry] Expired ${expired.length} stale pending donation(s).`);
}

module.exports = { expireStalePayments };

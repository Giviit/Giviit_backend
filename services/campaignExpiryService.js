const { supabase } = require('../utils/supabaseClient');
const email = require('./emailService');

// Runs daily at midnight (see node-cron job in server.js). Finds active
// campaigns whose deadline has passed, marks them completed, and notifies
// the creator + every distinct donor.
async function closeExpiredCampaigns() {
  const nowIso = new Date().toISOString();
  const { data: expired, error } = await supabase
    .from('campaigns')
    .select('id, title, creator_id, raised_amount')
    .eq('status', 'active')
    .not('deadline', 'is', null)
    .lt('deadline', nowIso);

  if (error) {
    console.error('[campaignExpiry] Failed to fetch expired campaigns:', error.message);
    return;
  }

  for (const campaign of expired || []) {
    try {
      await supabase
        .from('campaigns')
        .update({ status: 'completed', updated_at: nowIso })
        .eq('id', campaign.id);

      const { data: creator } = await supabase.from('profiles').select('email').eq('id', campaign.creator_id).single();
      if (creator?.email) {
        try {
          await email.campaignClosed(creator.email, {
            campaign_title: campaign.title,
            raised_amount: campaign.raised_amount,
          });
        } catch {}
      }

      const { data: donations } = await supabase
        .from('donations')
        .select('donor_email, donor_name')
        .eq('campaign_id', campaign.id)
        .eq('paystack_status', 'success');

      const seen = new Set();
      for (const d of donations || []) {
        if (!d.donor_email || seen.has(d.donor_email)) continue;
        seen.add(d.donor_email);
        try {
          await email.sendEmail({
            to: d.donor_email,
            subject: `Campaign you supported has ended — ${campaign.title}`,
            html: `<p>Hi ${d.donor_name || 'there'}, the campaign "${campaign.title}" you supported has ended successfully. Thank you for making a difference!</p>`,
          });
        } catch {}
      }
    } catch (err) {
      console.error(`[campaignExpiry] Failed to close campaign ${campaign.id}:`, err.message);
    }
  }

  if (expired?.length) {
    console.log(`[campaignExpiry] Closed ${expired.length} expired campaign(s).`);
  }
}

module.exports = { closeExpiredCampaigns };

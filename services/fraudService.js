const { supabase } = require('../utils/supabaseClient');
const emailService = require('./emailService');
const { getSettings } = require('./settingsService');

async function checkFraudTriggers(campaignId, creatorId) {
  const flags = [];

  // 1. Sudden spike: > ₦200k raised in < 2 hours
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: recentDons } = await supabase
    .from('donations')
    .select('amount')
    .eq('campaign_id', campaignId)
    .eq('paystack_status', 'success')
    .gte('created_at', twoHoursAgo);
  const recentTotal = (recentDons || []).reduce((s, d) => s + Number(d.amount), 0);
  if (recentTotal > 200000) {
    flags.push({ flag_type: 'SUDDEN_SPIKE', details: `₦${recentTotal.toLocaleString()} raised in under 2 hours` });
  }

  // 2. New account raising significant funds
  const { data: creator } = await supabase
    .from('profiles')
    .select('created_at')
    .eq('id', creatorId)
    .single();
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('raised_amount')
    .eq('id', campaignId)
    .single();
  if (creator && campaign) {
    const ageMs = Date.now() - new Date(creator.created_at).getTime();
    const raised = Number(campaign.raised_amount);
    if (ageMs < 24 * 60 * 60 * 1000 && raised > 50000) {
      flags.push({ flag_type: 'NEW_ACCOUNT_HIGH_RAISE', details: `Account < 24h old, raised ₦${raised.toLocaleString()}` });
    }
  }

  // 3. Multiple reports threshold
  const { count } = await supabase
    .from('reports')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', 'pending');
  if ((count || 0) >= 3) {
    flags.push({ flag_type: 'MULTIPLE_REPORTS', details: `${count} pending reports filed` });
  }

  for (const flag of flags) {
    const { data: existing } = await supabase
      .from('fraud_flags')
      .select('id')
      .eq('campaign_id', campaignId)
      .eq('flag_type', flag.flag_type)
      .eq('is_resolved', false)
      .single();
    if (!existing) {
      await supabase.from('fraud_flags').insert({ campaign_id: campaignId, ...flag });
      try {
        const { emailOnFraudFlag } = await getSettings();
        if (emailOnFraudFlag) await emailService.sendAdminAlert('Fraud flag raised', { campaignId, ...flag });
      } catch {}
    }
  }
}

module.exports = { checkFraudTriggers };

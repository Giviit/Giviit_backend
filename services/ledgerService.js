const { supabase } = require('../utils/supabaseClient');
const paystackService = require('./paystackService');

async function calculateCampaignBalance(campaignId) {
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('raised_amount')
    .eq('id', campaignId)
    .single();

  const raised = Number(campaign?.raised_amount || 0);

  const { data: completed } = await supabase
    .from('withdrawals')
    .select('amount')
    .eq('campaign_id', campaignId)
    .eq('status', 'completed');
  const withdrawn = (completed || []).reduce((s, w) => s + Number(w.amount), 0);

  const { data: pending } = await supabase
    .from('withdrawals')
    .select('amount')
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'processing']);
  const pendingAmount = (pending || []).reduce((s, w) => s + Number(w.amount), 0);

  const platformFee = raised * 0.03;
  const fraudReserve = raised * 0.005;
  const available = Math.max(0, raised - withdrawn - pendingAmount - platformFee - fraudReserve);

  return { raised, withdrawn, pending: pendingAmount, platformFee, fraudReserve, available };
}

async function reconcileMasterAccount() {
  let paystackBalance = 0;
  try {
    paystackBalance = await paystackService.getBalance();
  } catch {
    paystackBalance = 0;
  }

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, title, raised_amount')
    .in('status', ['active', 'pending', 'paused']);

  let totalAllocated = 0;
  let totalFees = 0;
  let totalReserve = 0;
  const campaignBalances = [];

  for (const c of campaigns || []) {
    const bal = await calculateCampaignBalance(c.id);
    totalAllocated += bal.available;
    totalFees += bal.platformFee;
    totalReserve += bal.fraudReserve;
    campaignBalances.push({ id: c.id, title: c.title, ...bal });
  }

  const unallocated = paystackBalance - totalAllocated - totalFees - totalReserve;

  return {
    paystackBalance,
    totalAllocated,
    platformFeesEarned: totalFees,
    fraudReserveBalance: totalReserve,
    unallocated,
    alert: Math.abs(unallocated) > 1000,
    campaigns: campaignBalances,
  };
}

module.exports = { calculateCampaignBalance, reconcileMasterAccount };

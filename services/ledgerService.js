const { supabase } = require('../utils/supabaseClient');
const paystackService = require('./paystackService');
const { getSettings } = require('./settingsService');

const FRAUD_RESERVE_RATE = 0.005;

// Records a donation's three linked ledger entries (credit + fee + reserve
// debits) atomically via the `record_ledger_entry` Postgres function, which
// locks the campaign row so concurrent writes never race on balance_after.
// The fee rate is read live from Settings so admins can adjust it without a
// deploy — already-recorded entries keep whatever rate was in effect when
// they were written (each entry stores its own rate in metadata).
async function recordDonationEntries({ userId, campaignId, amount, donationId, paystackReference }) {
  const { platformFeePercent } = await getSettings();
  const feeRate = Number(platformFeePercent) / 100;
  const fee = Number(amount) * feeRate;
  const reserve = Number(amount) * FRAUD_RESERVE_RATE;

  await supabase.rpc('record_ledger_entry', {
    p_user_id: userId, p_campaign_id: campaignId, p_entry_type: 'donation',
    p_amount: Number(amount), p_reference_table: 'donations', p_reference_id: donationId,
    p_paystack_reference: paystackReference, p_metadata: null,
  });
  await supabase.rpc('record_ledger_entry', {
    p_user_id: userId, p_campaign_id: campaignId, p_entry_type: 'platform_fee',
    p_amount: -fee, p_reference_table: 'donations', p_reference_id: donationId,
    p_paystack_reference: paystackReference, p_metadata: { rate: feeRate },
  });
  await supabase.rpc('record_ledger_entry', {
    p_user_id: userId, p_campaign_id: campaignId, p_entry_type: 'fraud_reserve',
    p_amount: -reserve, p_reference_table: 'donations', p_reference_id: donationId,
    p_paystack_reference: paystackReference, p_metadata: { rate: FRAUD_RESERVE_RATE },
  });
}

// Records a completed withdrawal's debit against the ledger.
async function recordWithdrawalEntry({ userId, campaignId, amount, withdrawalId, paystackReference }) {
  await supabase.rpc('record_ledger_entry', {
    p_user_id: userId, p_campaign_id: campaignId, p_entry_type: 'withdrawal',
    p_amount: -Number(amount), p_reference_table: 'withdrawals', p_reference_id: withdrawalId,
    p_paystack_reference: paystackReference, p_metadata: null,
  });
}

// Records a refund's debit, reversing a previously-credited donation.
async function recordRefundEntry({ userId, campaignId, amount, refundId, paystackReference }) {
  await supabase.rpc('record_ledger_entry', {
    p_user_id: userId, p_campaign_id: campaignId, p_entry_type: 'refund',
    p_amount: -Number(amount), p_reference_table: 'refunds', p_reference_id: refundId,
    p_paystack_reference: paystackReference, p_metadata: null,
  });
}

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

  // The ledger is the source of truth for the running balance — it already
  // nets out every donation credit, fee/reserve debit, and completed
  // withdrawal debit recorded for this campaign. Only currently pending /
  // processing withdrawals (not yet ledger-debited) need subtracting here.
  const { data: lastEntry } = await supabase
    .from('ledger_entries')
    .select('balance_after')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const ledgerBalance = Number(lastEntry?.balance_after || 0);

  const { data: feeRows } = await supabase
    .from('ledger_entries')
    .select('amount')
    .eq('campaign_id', campaignId)
    .eq('entry_type', 'platform_fee');
  const platformFee = Math.abs((feeRows || []).reduce((s, r) => s + Number(r.amount), 0));

  const { data: reserveRows } = await supabase
    .from('ledger_entries')
    .select('amount')
    .eq('campaign_id', campaignId)
    .eq('entry_type', 'fraud_reserve');
  const fraudReserve = Math.abs((reserveRows || []).reduce((s, r) => s + Number(r.amount), 0));

  const available = Math.max(0, ledgerBalance - pendingAmount);

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

module.exports = {
  calculateCampaignBalance,
  reconcileMasterAccount,
  recordDonationEntries,
  recordWithdrawalEntry,
  recordRefundEntry,
};

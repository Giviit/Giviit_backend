const { supabase } = require('../utils/supabaseClient');

const PLATFORM_FEE_RATE = 0.03;
const FRAUD_RESERVE_RATE = 0.005;

async function getAnalytics(req, res, next) {
  try {
    const creatorId = req.user.id;

    const { data: campaigns, error: campaignsError } = await supabase
      .from('campaigns')
      .select('id, raised_amount')
      .eq('creator_id', creatorId);
    if (campaignsError) throw campaignsError;

    const campaignIds = (campaigns || []).map(c => c.id);
    const totalRaised = (campaigns || []).reduce((sum, c) => sum + Number(c.raised_amount || 0), 0);
    const platformFeesPaid = totalRaised * PLATFORM_FEE_RATE;
    const fraudReserve = totalRaised * FRAUD_RESERVE_RATE;

    let totalWithdrawn = 0;
    let pendingWithdrawals = 0;
    let donations = [];
    let totalDonors = 0;

    if (campaignIds.length) {
      const { data: withdrawals } = await supabase
        .from('withdrawals')
        .select('amount, status')
        .in('campaign_id', campaignIds);

      for (const w of withdrawals || []) {
        if (w.status === 'completed') totalWithdrawn += Number(w.amount);
        else if (w.status === 'pending' || w.status === 'processing') pendingWithdrawals += Number(w.amount);
      }

      const { data: donationRows } = await supabase
        .from('donations')
        .select('amount, donor_email, created_at')
        .in('campaign_id', campaignIds)
        .eq('paystack_status', 'success');

      donations = donationRows || [];
      totalDonors = new Set(donations.map(d => d.donor_email)).size;
    }

    const availableBalance = Math.max(
      0,
      totalRaised - totalWithdrawn - pendingWithdrawals - platformFeesPaid - fraudReserve
    );

    // Last 6 calendar months, oldest first — current month is always last.
    const now = new Date();
    const months = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      return { key: `${d.getFullYear()}-${d.getMonth()}`, month: d.toLocaleString('en', { month: 'short' }), amount: 0 };
    });
    const monthIndexByKey = Object.fromEntries(months.map((m, i) => [m.key, i]));

    for (const d of donations) {
      const dt = new Date(d.created_at);
      const key = `${dt.getFullYear()}-${dt.getMonth()}`;
      if (key in monthIndexByKey) months[monthIndexByKey[key]].amount += Number(d.amount);
    }

    res.json({
      total_raised: totalRaised,
      available_balance: availableBalance,
      platform_fees_paid: platformFeesPaid,
      fraud_reserve: fraudReserve,
      total_withdrawn: totalWithdrawn,
      pending_withdrawals: pendingWithdrawals,
      this_month: months[months.length - 1].amount,
      last_month: months[months.length - 2].amount,
      total_donors: totalDonors,
      monthly: months.map(({ month, amount }) => ({ month, amount })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAnalytics };

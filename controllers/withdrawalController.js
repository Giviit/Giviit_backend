const { supabase } = require('../utils/supabaseClient');
const { calculateCampaignBalance } = require('../services/ledgerService');
const { logAudit } = require('../utils/auditLog');
const email = require('../services/emailService');

async function requestWithdrawal(req, res, next) {
  try {
    const { campaign_id, amount, bank_name, account_number, account_name, bank_code } = req.body;
    const creator_id = req.user.id;

    // KYC check
    const { data: kyc } = await supabase
      .from('kyc_verifications')
      .select('status')
      .eq('user_id', creator_id)
      .eq('status', 'verified')
      .single();

    if (!kyc) {
      return res.status(403).json({ error: 'Complete identity verification (KYC) before withdrawing' });
    }

    // Ownership check
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('creator_id, title, status')
      .eq('id', campaign_id)
      .single();

    if (campaignError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== creator_id) return res.status(403).json({ error: 'Forbidden' });
    if (campaign.status !== 'active') return res.status(400).json({ error: 'Campaign is not active' });

    const withdrawAmount = Number(amount);
    if (withdrawAmount < 1000) return res.status(400).json({ error: 'Minimum withdrawal is ₦1,000' });

    // Live balance check
    const balance = await calculateCampaignBalance(campaign_id);
    if (withdrawAmount > balance.available) {
      return res.status(400).json({
        error: `Insufficient balance. Available: ₦${balance.available.toLocaleString()}`,
        balance,
      });
    }

    const { data, error } = await supabase
      .from('withdrawals')
      .insert([{
        campaign_id,
        creator_id,
        amount: withdrawAmount,
        bank_name,
        account_number,
        account_name,
        bank_code: bank_code || '',
        status: 'pending',
      }])
      .select()
      .single();

    if (error) throw error;

    await logAudit({ action: 'WITHDRAWAL_REQUESTED', entityType: 'withdrawal', entityId: data.id, performedBy: creator_id, metadata: { amount: withdrawAmount, campaign_id } });

    try {
      await email.sendAdminAlert('New withdrawal request', {
        creator: req.user.full_name,
        campaign: campaign.title,
        amount: withdrawAmount,
        bank: `${bank_name} ${account_number}`,
      });
    } catch {}

    res.status(201).json({ withdrawal: data });
  } catch (err) {
    next(err);
  }
}

async function getMyWithdrawals(req, res, next) {
  try {
    const { data, error } = await supabase
      .from('withdrawals')
      .select('*, campaign:campaigns(id,title)')
      .eq('creator_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ withdrawals: data || [] });
  } catch (err) {
    next(err);
  }
}

async function getCampaignBalance(req, res, next) {
  try {
    const { campaign_id } = req.params;

    const { data: campaign } = await supabase
      .from('campaigns')
      .select('creator_id')
      .eq('id', campaign_id)
      .single();

    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const balance = await calculateCampaignBalance(campaign_id);
    res.json({ balance });
  } catch (err) {
    next(err);
  }
}

module.exports = { requestWithdrawal, getMyWithdrawals, getCampaignBalance };

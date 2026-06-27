const { supabase } = require('../utils/supabaseClient');
const { calculateCampaignBalance } = require('../services/ledgerService');
const { getSettings } = require('../services/settingsService');
const { logAudit } = require('../utils/auditLog');
const email = require('../services/emailService');
const paystackService = require('../services/paystackService');
const NIGERIAN_BANKS = require('../utils/nigerianBanks');

const SINGLE_WITHDRAWAL_LIMIT = 2000000;
const DAILY_WITHDRAWAL_LIMIT = 5000000;

// Donor-style 10-digit-then-bank account lookup, fired automatically by the
// frontend as soon as both fields are filled — no submit button. Rate
// limited per-user in withdrawalRoutes.js (10/min) since each keystroke
// combination can trigger a call.
async function resolveAccount(req, res, next) {
  try {
    const { account_number, bank_code } = req.query;
    if (!account_number || !/^\d{10}$/.test(account_number)) {
      return res.status(400).json({ error: 'Account number must be exactly 10 digits' });
    }
    if (!bank_code || !NIGERIAN_BANKS.some((b) => b.code === bank_code)) {
      return res.status(400).json({ error: 'Unrecognized bank' });
    }

    try {
      const resolved = await paystackService.resolveAccount({ account_number, bank_code });
      res.json({
        account_name: resolved.account_name,
        account_number: resolved.account_number,
        bank_code,
      });
    } catch {
      res.status(400).json({ error: 'Account not found. Please check the account number and bank.' });
    }
  } catch (err) {
    next(err);
  }
}

async function requestWithdrawal(req, res, next) {
  const { campaign_id, amount, bank_name, account_number, account_name, bank_code } = req.body;
  const creator_id = req.user.id;
  let withdrawalId = null;

  try {
    const settings = await getSettings();

    // KYC check (admin can switch this off platform-wide via Settings)
    if (settings.requireKycForWithdrawal) {
      const { data: kyc } = await supabase
        .from('kyc_verifications')
        .select('status')
        .eq('user_id', creator_id)
        .eq('status', 'verified')
        .single();

      if (!kyc) {
        return res.status(403).json({
          error: 'Complete identity verification before withdrawing',
          code: 'KYC_REQUIRED',
        });
      }
    }

    if (!bank_code || !NIGERIAN_BANKS.some((b) => b.code === bank_code)) {
      return res.status(400).json({ error: 'Unrecognized bank' });
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
    if (withdrawAmount < Number(settings.minWithdrawalAmount)) {
      return res.status(400).json({ error: `Minimum withdrawal is ₦${Number(settings.minWithdrawalAmount).toLocaleString()}` });
    }

    // Single-withdrawal and rolling-daily safety caps — these apply
    // regardless of available balance, since there's no human review step
    // left to catch an unusually large autonomous transfer.
    if (withdrawAmount > SINGLE_WITHDRAWAL_LIMIT) {
      return res.status(400).json({
        error: `Maximum single withdrawal is ₦${SINGLE_WITHDRAWAL_LIMIT.toLocaleString()}. Please split into multiple withdrawals.`,
        code: 'EXCEEDS_LIMIT',
      });
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const { data: todaysWithdrawals } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('creator_id', creator_id)
      .in('status', ['processing', 'completed'])
      .gte('created_at', startOfToday.toISOString());
    const todayTotal = (todaysWithdrawals || []).reduce((sum, w) => sum + Number(w.amount), 0);

    if (todayTotal + withdrawAmount > DAILY_WITHDRAWAL_LIMIT) {
      return res.status(400).json({
        error: 'Daily withdrawal limit reached. Try again tomorrow.',
        code: 'DAILY_LIMIT_REACHED',
      });
    }

    // Atomic balance check + insert via a Postgres function that locks the
    // campaign row for the duration of the check, so two concurrent
    // withdrawal requests can never both read the same "available" balance
    // before either one commits (closes the double-withdrawal race).
    // Inserted directly as 'processing' — there's no admin approval step to
    // wait in 'pending' for, since the transfer fires right after this.
    const { data: withdrawal, error } = await supabase.rpc('request_withdrawal_atomic', {
      p_campaign_id: campaign_id,
      p_creator_id: creator_id,
      p_amount: withdrawAmount,
      p_bank_name: bank_name,
      p_account_number: account_number,
      p_account_name: account_name,
      p_bank_code: bank_code,
      p_status: 'processing',
    });

    if (error) {
      if (error.message?.includes('INSUFFICIENT_BALANCE')) {
        const balance = await calculateCampaignBalance(campaign_id);
        return res.status(400).json({
          error: `Insufficient balance. Available: ₦${balance.available.toLocaleString()}`,
          available_balance: balance.available,
          balance,
        });
      }
      throw error;
    }

    withdrawalId = withdrawal.id;

    // Reuse a previously-resolved recipient for this exact account if the
    // creator has withdrawn here before — saves a Paystack call and keeps
    // the verified account name and recipient code in sync.
    const { data: savedBank } = await supabase
      .from('bank_details')
      .select('paystack_recipient_code')
      .eq('user_id', creator_id)
      .eq('account_number', account_number)
      .maybeSingle();

    let recipientCode = savedBank?.paystack_recipient_code;
    if (!recipientCode) {
      const recipient = await paystackService.createTransferRecipient({
        name: account_name,
        account_number,
        bank_code,
      });
      recipientCode = recipient.recipient_code;

      await supabase.from('bank_details').upsert({
        user_id: creator_id,
        bank_name,
        bank_code,
        account_number,
        account_name,
        paystack_recipient_code: recipientCode,
        is_verified: true,
        is_default: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,account_number' });
    }

    const transferRef = `GIVIIT_WD_${withdrawalId.slice(0, 8)}_${Date.now()}`;
    const transfer = await paystackService.transferToRecipient({
      amount: withdrawAmount,
      recipient: recipientCode,
      reason: `Giviit withdrawal — ${campaign.title}`,
      reference: transferRef,
    });

    await supabase.from('withdrawals').update({
      paystack_recipient_code: recipientCode,
      paystack_transfer_code: transfer.transfer_code,
      paystack_transfer_reference: transferRef,
      updated_at: new Date().toISOString(),
    }).eq('id', withdrawalId);

    // Only the last 4 digits of the account number are ever logged — never
    // the full account number.
    await logAudit({
      action: 'WITHDRAWAL_INITIATED',
      entityType: 'withdrawal',
      entityId: withdrawalId,
      performedBy: creator_id,
      metadata: {
        amount: withdrawAmount,
        bank_name,
        account_last4: String(account_number).slice(-4),
        campaign_id,
      },
    });

    try {
      await email.withdrawalProcessing(req.user.email, {
        amount: withdrawAmount,
        account_name,
        bank_name,
        bank_last4: String(account_number).slice(-4),
        campaign_title: campaign.title,
      });
    } catch {}

    res.status(201).json({
      message: 'Withdrawal initiated successfully',
      withdrawal_id: withdrawalId,
      status: 'processing',
      estimated_arrival: '5-10 minutes',
    });
  } catch (err) {
    // The transfer call itself failed after the withdrawal row was created
    // and the balance locked — flip it to 'failed' so the amount is no
    // longer counted as pending/processing and the balance frees back up.
    if (withdrawalId) {
      await supabase.from('withdrawals').update({
        status: 'failed',
        admin_note: err.message,
        updated_at: new Date().toISOString(),
      }).eq('id', withdrawalId).catch(() => {});
    }
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

module.exports = { requestWithdrawal, getMyWithdrawals, getCampaignBalance, resolveAccount };

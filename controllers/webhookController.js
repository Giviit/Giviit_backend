const crypto = require('crypto');
const { supabase } = require('../utils/supabaseClient');
const email = require('../services/emailService');
const { checkFraudTriggers } = require('../services/fraudService');
const { logAudit } = require('../utils/auditLog');
const { recordDonationEntries, recordWithdrawalEntry } = require('../services/ledgerService');
const { getSettings } = require('../services/settingsService');
const { advancePledge } = require('../services/pledgeService');
const { initiateRefund } = require('../services/paystackService');
const { capAmount, handleGoalReached } = require('../services/overfundingService');

function verifySignature(rawBody, signature) {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}

async function handlePaystackWebhook(req, res) {
  // Always respond 200 immediately to Paystack
  res.status(200).json({ status: 'ok' });

  try {
    const rawBody = req.body; // raw buffer from express.raw()
    const signature = req.headers['x-paystack-signature'];
    if (!verifySignature(rawBody, signature)) return;

    const event = JSON.parse(rawBody.toString());

    if (event.event === 'charge.success') {
      await handleChargeSuccess(event.data);
    } else if (event.event === 'transfer.success') {
      await handleTransferSuccess(event.data);
    } else if (event.event === 'transfer.failed') {
      await handleTransferFailed(event.data);
    } else if (event.event === 'transfer.reversed') {
      await handleTransferReversed(event.data);
    }
  } catch (err) {
    console.error('[Paystack webhook]', err.message);
  }
}

async function handleChargeSuccess(data) {
  const reference = data.reference;
  const amount = data.amount / 100;

  // Atomic conditional update — only succeeds (returns a row) if this call is
  // the one that actually flips the status, so a race with the frontend's
  // verify endpoint can never double-increment the campaign totals.
  const { data: donation, error: updateError } = await supabase
    .from('donations')
    .update({ paystack_status: 'success', paystack_transaction_id: data.id || null })
    .eq('paystack_reference', reference)
    .neq('paystack_status', 'success')
    .select()
    .maybeSingle();

  if (updateError) {
    console.error('[Paystack webhook] Failed to update donation status:', updateError.message);
    return;
  }
  if (!donation) return; // not found, or already processed by another request

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, raised_amount, donor_count, creator_id, title, slug, goal_amount, goal_reached_at')
    .eq('id', donation.campaign_id)
    .single();

  if (campaign) {
    const previousRaised = Number(campaign.raised_amount || 0);
    const goalAmount = Number(campaign.goal_amount || 0);

    // Defensive re-cap — see donationController.verifyDonation for why this
    // can still trigger even though initiateDonation already capped the charge.
    const { cappedAmount, excessAmount } = capAmount(amount, previousRaised, goalAmount);
    if (excessAmount > 0) {
      try {
        await initiateRefund({ transaction: reference, amount: excessAmount });
      } catch (err) {
        console.error('[overfunding] Failed to refund excess donation amount:', err.message);
      }
    }

    const newRaised = previousRaised + cappedAmount;
    await supabase
      .from('campaigns')
      .update({ raised_amount: newRaised, donor_count: Number(campaign.donor_count || 0) + 1 })
      .eq('id', donation.campaign_id);

    try {
      await handleGoalReached({ campaign, newRaised });
    } catch (err) {
      console.error('[overfunding] handleGoalReached failed:', err.message);
    }

    try {
      await recordDonationEntries({
        userId: campaign.creator_id,
        campaignId: donation.campaign_id,
        amount: cappedAmount,
        donationId: donation.id,
        paystackReference: reference,
      });
    } catch (err) {
      console.error('[ledger] Failed to record donation entries:', err.message);
    }

    await logAudit({
      action: 'DONATION_SUCCEEDED',
      entityType: 'donation',
      entityId: donation.id,
      metadata: { campaign_id: donation.campaign_id, amount: cappedAmount, gross_amount: amount, paystack_reference: reference, via: 'webhook' },
    });

    // Check and update milestones
    const { data: milestones } = await supabase
      .from('campaign_milestones')
      .select('*')
      .eq('campaign_id', donation.campaign_id)
      .eq('is_reached', false)
      .lte('amount', newRaised);
    if (milestones?.length) {
      for (const m of milestones) {
        await supabase
          .from('campaign_milestones')
          .update({ is_reached: true, reached_at: new Date().toISOString() })
          .eq('id', m.id);
      }
    }

    // Fraud detection
    try {
      await checkFraudTriggers(donation.campaign_id, campaign.creator_id);
    } catch {}

    // Donor receipt + creator notification emails
    const campaignUrl = `${process.env.FRONTEND_URL}/campaign/${campaign.slug || ''}`;
    try {
      await email.donorReceipt(donation.donor_email, {
        campaign_title: campaign.title || 'your campaign',
        amount: cappedAmount,
        reference,
        campaign_url: campaignUrl,
        donor_name: donation.donor_name,
        is_anonymous: donation.is_anonymous,
        currency: donation.currency,
        donated_at: donation.created_at,
        payment_channel: donation.payment_channel,
      });
    } catch {}

    try {
      const { data: creator } = await supabase.from('profiles').select('email').eq('id', campaign.creator_id).single();
      if (creator?.email) {
        await email.creatorDonationReceived(creator.email, {
          donor_name: donation.donor_name,
          is_anonymous: donation.is_anonymous,
          amount: cappedAmount,
          campaign_title: campaign.title,
          campaign_url: campaignUrl,
          total_raised: newRaised,
          goal_amount: campaign.goal_amount,
        });
      }
    } catch {}

    if (donation.pledge_id) {
      try {
        await advancePledge(donation.pledge_id);
      } catch (err) {
        console.error('[pledge] Failed to advance pledge:', err.message);
      }
    }
  }
}

async function handleTransferSuccess(data) {
  const ref = data.reference;
  const { data: withdrawal } = await supabase
    .from('withdrawals')
    .select('*, profiles(email)')
    .eq('paystack_transfer_reference', ref)
    .single();

  if (!withdrawal) return;

  await supabase
    .from('withdrawals')
    .update({ status: 'completed', updated_at: new Date().toISOString() })
    .eq('id', withdrawal.id);

  try {
    await recordWithdrawalEntry({
      userId: withdrawal.creator_id,
      campaignId: withdrawal.campaign_id,
      amount: withdrawal.amount,
      withdrawalId: withdrawal.id,
      paystackReference: ref,
    });
  } catch (err) {
    console.error('[ledger] Failed to record withdrawal entry:', err.message);
  }

  await logAudit({ action: 'WITHDRAWAL_COMPLETED', entityType: 'withdrawal', entityId: withdrawal.id, performedBy: withdrawal.creator_id, metadata: { amount: withdrawal.amount } });

  try {
    await email.withdrawalCompleted(withdrawal.profiles?.email, {
      amount: withdrawal.amount,
      bank_name: withdrawal.bank_name,
      bank_last4: String(withdrawal.account_number || '').slice(-4),
    });
  } catch {}
}

// No ledger entry is ever recorded for a withdrawal until this transfer.success
// handler runs (see ledgerService.recordWithdrawalEntry), so a withdrawal that
// fails or reverses before then never actually debited the campaign's balance
// — calculateCampaignBalance only excludes amounts still 'pending'/'processing'.
// Flipping the status away from those is all that's needed to "restore" it.
async function handleTransferFailed(data) {
  const ref = data.reference;
  const { data: withdrawal } = await supabase
    .from('withdrawals')
    .select('*, profiles(email)')
    .eq('paystack_transfer_reference', ref)
    .single();

  if (!withdrawal) return;

  await supabase
    .from('withdrawals')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('id', withdrawal.id);

  await logAudit({ action: 'WITHDRAWAL_FAILED', entityType: 'withdrawal', entityId: withdrawal.id, metadata: { reason: data.reason } });

  try {
    await email.withdrawalFailed(withdrawal.profiles?.email, { amount: withdrawal.amount, reason: data.reason });
    const { emailOnWithdrawal } = await getSettings();
    if (emailOnWithdrawal) await email.sendAdminAlert('Transfer failed', { withdrawal_id: withdrawal.id, amount: withdrawal.amount });
  } catch {}
}

async function handleTransferReversed(data) {
  const ref = data.reference;
  const { data: withdrawal } = await supabase
    .from('withdrawals')
    .select('*, profiles(email)')
    .eq('paystack_transfer_reference', ref)
    .single();

  if (!withdrawal) return;

  await supabase
    .from('withdrawals')
    .update({ status: 'reversed', updated_at: new Date().toISOString() })
    .eq('id', withdrawal.id);

  await logAudit({ action: 'WITHDRAWAL_REVERSED', entityType: 'withdrawal', entityId: withdrawal.id, metadata: { reason: data.reason } });

  try {
    await email.withdrawalFailed(withdrawal.profiles?.email, { amount: withdrawal.amount, reason: data.reason || 'Transfer was reversed by the bank' });
    const { emailOnWithdrawal } = await getSettings();
    if (emailOnWithdrawal) await email.sendAdminAlert('Transfer reversed', { withdrawal_id: withdrawal.id, amount: withdrawal.amount });
  } catch {}
}

module.exports = { handlePaystackWebhook };

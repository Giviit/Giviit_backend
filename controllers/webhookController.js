const crypto = require('crypto');
const { supabase } = require('../utils/supabaseClient');
const email = require('../services/emailService');
const { checkFraudTriggers } = require('../services/fraudService');
const { logAudit } = require('../utils/auditLog');

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
    }
  } catch (err) {
    console.error('[Paystack webhook]', err.message);
  }
}

async function handleChargeSuccess(data) {
  const reference = data.reference;
  const amount = data.amount / 100;

  const { data: donation } = await supabase
    .from('donations')
    .select('*')
    .eq('paystack_reference', reference)
    .single();

  if (!donation || donation.paystack_status === 'success') return; // idempotent

  await supabase
    .from('donations')
    .update({ paystack_status: 'success' })
    .eq('paystack_reference', reference);

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('raised_amount, donor_count, creator_id, title')
    .eq('id', donation.campaign_id)
    .single();

  if (campaign) {
    const newRaised = Number(campaign.raised_amount || 0) + amount;
    await supabase
      .from('campaigns')
      .update({ raised_amount: newRaised, donor_count: Number(campaign.donor_count || 0) + 1 })
      .eq('id', donation.campaign_id);

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
  }

  // Donor receipt email
  const campaignUrl = `${process.env.FRONTEND_URL}/campaign/${campaign?.slug || ''}`;
  try {
    await email.donorReceipt(donation.donor_email, {
      campaign_title: campaign?.title || 'your campaign',
      amount,
      reference,
      campaign_url: campaignUrl,
    });
  } catch {}
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

  const { data: camp } = await supabase.from('campaigns').select('withdrawn_amount').eq('id', withdrawal.campaign_id).single();
  await supabase
    .from('campaigns')
    .update({ withdrawn_amount: Number(camp?.withdrawn_amount || 0) + Number(withdrawal.amount) })
    .eq('id', withdrawal.campaign_id);

  await logAudit({ action: 'WITHDRAWAL_COMPLETED', entityType: 'withdrawal', entityId: withdrawal.id });

  try {
    await email.withdrawalCompleted(withdrawal.profiles?.email, { amount: withdrawal.amount });
  } catch {}
}

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

  await logAudit({ action: 'WITHDRAWAL_FAILED', entityType: 'withdrawal', entityId: withdrawal.id });

  try {
    await email.withdrawalFailed(withdrawal.profiles?.email, { amount: withdrawal.amount, reason: data.reason });
    await email.sendAdminAlert('Transfer failed', { withdrawal_id: withdrawal.id, amount: withdrawal.amount });
  } catch {}
}

module.exports = { handlePaystackWebhook };

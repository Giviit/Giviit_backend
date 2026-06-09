const { supabase } = require('../utils/supabaseClient');
const shuftiPro = require('../services/shuftiProService');
const email = require('../services/emailService');
const { logAudit } = require('../utils/auditLog');

async function initiateKyc(req, res, next) {
  try {
    const userId = req.user.id;
    const { nin } = req.body;

    // Check if already verified
    const { data: existing } = await supabase
      .from('kyc_verifications')
      .select('status, attempt_count')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (existing?.status === 'verified') {
      return res.status(400).json({ error: 'Already verified' });
    }

    // Retry limit: max 3 attempts
    if ((existing?.attempt_count || 0) >= 3) {
      return res.status(400).json({ error: 'Maximum verification attempts reached. Contact support at support@giviit.ng' });
    }

    const reference = `GIVIIT_KYC_${userId.slice(0, 8)}_${Date.now()}`;
    const nameParts = req.user.full_name?.split(' ') || [];

    // Upsert KYC record
    const { data: kycRecord } = await supabase
      .from('kyc_verifications')
      .insert({
        user_id: userId,
        reference,
        nin: nin || null,
        status: 'pending',
        attempt_count: (existing?.attempt_count || 0) + 1,
      })
      .select()
      .single();

    const result = await shuftiPro.initiateVerification({
      reference,
      user: {
        first_name: nameParts[0] || '',
        last_name: nameParts.slice(1).join(' ') || '',
        nin: nin || '',
      },
    });

    await supabase
      .from('kyc_verifications')
      .update({ shufti_reference: result.reference || reference })
      .eq('id', kycRecord.id);

    return res.json({ verification_url: result.verification_url, reference });
  } catch (err) {
    next(err);
  }
}

async function getKycStatus(req, res, next) {
  try {
    const { data } = await supabase
      .from('kyc_verifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    res.json({ kyc: data || null });
  } catch (err) {
    next(err);
  }
}

async function handleShuftiWebhook(req, res) {
  try {
    const signature = req.headers['sp-signature'];
    if (signature && !shuftiPro.verifyWebhookSignature(req.body, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body;
    const reference = event.reference;
    if (!reference) return res.status(200).json({ ok: true });

    const { data: kyc } = await supabase
      .from('kyc_verifications')
      .select('*, profiles(email)')
      .eq('reference', reference)
      .single();

    if (!kyc) return res.status(200).json({ ok: true });

    const verified =
      event.verification_result === 1 ||
      event.event === 'verification.accepted' ||
      event.event === 'request.pending'; // pending = in manual review

    const newStatus = verified ? 'verified' : 'failed';

    await supabase
      .from('kyc_verifications')
      .update({
        status: newStatus,
        shufti_response: event,
        verified_at: verified ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('reference', reference);

    const userEmail = kyc.profiles?.email;
    if (userEmail) {
      if (verified) await email.kycVerified(userEmail).catch(() => {});
      else await email.kycFailed(userEmail).catch(() => {});
    }

    await logAudit({
      action: verified ? 'KYC_VERIFIED' : 'KYC_FAILED',
      entityType: 'kyc',
      entityId: kyc.id,
      metadata: { reference },
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[KYC webhook]', err.message);
    res.status(200).json({ ok: true });
  }
}

module.exports = { initiateKyc, getKycStatus, handleShuftiWebhook };

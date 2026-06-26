const { supabase } = require('../utils/supabaseClient');
const { initiateTransaction, verifyTransaction } = require('../services/paystackService');
const { recordDonationEntries } = require('../services/ledgerService');
const { getSettings } = require('../services/settingsService');
const { logAudit } = require('../utils/auditLog');
const email = require('../services/emailService');

async function initiateDonation(req, res, next) {
  try {
    const { campaign_id, donor_name, donor_email, amount, is_anonymous, message } = req.body;
    if (!campaign_id || !donor_email || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const paystackData = await initiateTransaction({
      email: donor_email,
      amount: Number(amount),
      campaign_id,
      donor_name,
      is_anonymous,
      message,
    });

    await supabase.from('donations').insert([{
      campaign_id,
      donor_name: donor_name || 'Anonymous',
      donor_email,
      amount: Number(amount),
      currency: 'NGN',
      is_anonymous: !!is_anonymous,
      message: message || null,
      paystack_reference: paystackData.reference,
      paystack_status: 'pending',
    }]);

    res.json({ authorization_url: paystackData.authorization_url, reference: paystackData.reference });
  } catch (err) {
    next(err);
  }
}

async function verifyDonation(req, res, next) {
  try {
    const { reference } = req.params;
    const paystackResult = await verifyTransaction(reference);
    const status = paystackResult.status === 'success' ? 'success' : 'failed';

    const { data: existing } = await supabase
      .from('donations')
      .select('*')
      .eq('paystack_reference', reference)
      .single();

    if (!existing) return res.status(404).json({ error: 'Donation not found' });

    // Already settled by a previous call (frontend redirect + webhook racing
    // each other) — nothing to do, just report the existing state.
    let donation = null;
    let settled = existing;

    if (existing.paystack_status !== 'success') {
      // Atomic conditional update — only the request that actually flips the
      // status away from a non-success value gets a row back. This makes the
      // campaign-totals increment below run at most once per donation, even if
      // verify is called concurrently (dev double-effects, retries, or a race
      // with the Paystack webhook hitting the same reference).
      const { data: updated, error: updateError } = await supabase
        .from('donations')
        .update({ paystack_status: status, paystack_transaction_id: paystackResult.id || null })
        .eq('paystack_reference', reference)
        .neq('paystack_status', 'success')
        .select()
        .maybeSingle();

      if (updateError) throw updateError;

      if (updated) {
        donation = updated;
        settled = updated;
      } else {
        // Lost the race to a concurrent call — re-read the now-current row.
        const { data: fresh } = await supabase.from('donations').select('*').eq('paystack_reference', reference).single();
        if (fresh) settled = fresh;
      }
    }

    if (donation && status === 'success') {
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('raised_amount, donor_count, creator_id, title, slug, goal_amount')
        .eq('id', donation.campaign_id)
        .single();

      if (campaign) {
        const newRaised = Number(campaign.raised_amount || 0) + Number(donation.amount);
        await supabase.from('campaigns').update({
          raised_amount: newRaised,
          donor_count: Number(campaign.donor_count || 0) + 1,
        }).eq('id', donation.campaign_id);

        try {
          await recordDonationEntries({
            userId: campaign.creator_id,
            campaignId: donation.campaign_id,
            amount: donation.amount,
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
          metadata: { campaign_id: donation.campaign_id, amount: donation.amount, paystack_reference: reference },
        });

        const campaignUrl = `${process.env.FRONTEND_URL}/campaign/${campaign.slug || ''}`;
        try {
          await email.donorReceipt(donation.donor_email, {
            campaign_title: campaign.title || 'your campaign',
            amount: donation.amount,
            reference,
            campaign_url: campaignUrl,
            donor_name: donation.donor_name,
            is_anonymous: donation.is_anonymous,
            currency: donation.currency,
            donated_at: donation.created_at,
          });
        } catch {}

        try {
          const { data: creator } = await supabase.from('profiles').select('email').eq('id', campaign.creator_id).single();
          if (creator?.email) {
            await email.creatorDonationReceived(creator.email, {
              donor_name: donation.donor_name,
              is_anonymous: donation.is_anonymous,
              amount: donation.amount,
              campaign_title: campaign.title,
              campaign_url: campaignUrl,
              total_raised: newRaised,
              goal_amount: campaign.goal_amount,
            });
          }
        } catch {}
      }
    }

    // Get campaign for response
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id, title, slug, raised_amount, goal_amount')
      .eq('id', existing.campaign_id)
      .single();

    res.json({
      status: settled.paystack_status,
      donation: settled,
      campaign,
    });
  } catch (err) {
    next(err);
  }
}

async function getCampaignDonations(req, res, next) {
  try {
    const { campaign_id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const { data, error, count } = await supabase
      .from('donations')
      .select('id, donor_name, amount, is_anonymous, message, created_at', { count: 'exact' })
      .eq('campaign_id', campaign_id)
      .eq('paystack_status', 'success')
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (error) throw error;
    res.json({ donations: data || [], total: count || 0 });
  } catch (err) {
    next(err);
  }
}

async function logOfflineDonation(req, res, next) {
  try {
    const { enableOfflineDonations } = await getSettings();
    if (!enableOfflineDonations) {
      return res.status(403).json({ error: 'Offline donation logging is currently disabled on Giviit.' });
    }

    const { campaign_id, donor_name, amount, note, donated_at } = req.body;
    const creator_id = req.user.id;

    const { data: campaign } = await supabase.from('campaigns').select('creator_id').eq('id', campaign_id).single();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== creator_id) return res.status(403).json({ error: 'Forbidden' });

    const { data, error } = await supabase
      .from('offline_donations')
      .insert({
        campaign_id,
        creator_id,
        donor_name,
        amount,
        note,
        donated_at: donated_at || new Date().toISOString().split('T')[0],
      })
      .select()
      .single();
    if (error) throw error;
    await supabase.rpc('increment_campaign_raised', { p_campaign_id: campaign_id, p_amount: amount });
    res.json({ offline_donation: data });
  } catch (err) {
    next(err);
  }
}

async function deleteOfflineDonation(req, res, next) {
  try {
    const { id } = req.params;
    const { data: od } = await supabase.from('offline_donations').select('*').eq('id', id).single();

    if (!od) return res.status(404).json({ error: 'Not found' });
    if (od.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    await supabase.from('offline_donations').delete().eq('id', id);
    await supabase.rpc('decrement_campaign_raised', { p_campaign_id: od.campaign_id, p_amount: od.amount });
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
}

async function getOfflineDonations(req, res, next) {
  try {
    const { campaign_id } = req.params;

    const { data: campaign } = await supabase.from('campaigns').select('creator_id').eq('id', campaign_id).single();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { data, error } = await supabase
      .from('offline_donations')
      .select('*')
      .eq('campaign_id', campaign_id)
      .order('donated_at', { ascending: false });
    if (error) throw error;
    res.json({ offline_donations: data || [] });
  } catch (err) {
    next(err);
  }
}

async function getMyDonations(req, res, next) {
  try {
    const creatorId = req.user.id;
    const limit = Number(req.query.limit) || 10;

    const { data: campaigns } = await supabase.from('campaigns').select('id').eq('creator_id', creatorId);
    const campaignIds = (campaigns || []).map(c => c.id);
    if (!campaignIds.length) return res.json({ donations: [] });

    const { data, error } = await supabase
      .from('donations')
      .select('id, donor_name, is_anonymous, amount, created_at, campaign:campaigns(id,title,slug)')
      .in('campaign_id', campaignIds)
      .eq('paystack_status', 'success')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ donations: data || [] });
  } catch (err) {
    next(err);
  }
}

async function getDiasporaDonors(req, res, next) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('donations')
      .select('donor_name, donor_country, donor_currency, amount, is_anonymous, created_at')
      .eq('campaign_id', id)
      .not('donor_country', 'is', null)
      .neq('donor_currency', 'NGN')
      .order('amount', { ascending: false })
      .limit(5);
    if (error) throw error;
    res.json({ diaspora_donors: data || [] });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  initiateDonation,
  verifyDonation,
  getCampaignDonations,
  getMyDonations,
  logOfflineDonation,
  deleteOfflineDonation,
  getOfflineDonations,
  getDiasporaDonors,
};

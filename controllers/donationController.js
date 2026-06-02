const { supabase } = require('../utils/supabaseClient');
const { initiateTransaction, verifyTransaction } = require('../services/paystackService');

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

    const { data: donation } = await supabase
      .from('donations')
      .select('*')
      .eq('paystack_reference', reference)
      .single();

    if (!donation) return res.status(404).json({ error: 'Donation not found' });

    // Only update if not already verified
    if (donation.paystack_status !== 'success') {
      await supabase.from('donations').update({ paystack_status: status }).eq('paystack_reference', reference);

      if (status === 'success') {
        const { data: campaign } = await supabase
          .from('campaigns')
          .select('raised_amount, donor_count')
          .eq('id', donation.campaign_id)
          .single();

        if (campaign) {
          await supabase.from('campaigns').update({
            raised_amount: Number(campaign.raised_amount || 0) + Number(donation.amount),
            donor_count: Number(campaign.donor_count || 0) + 1,
          }).eq('id', donation.campaign_id);
        }
      }
    }

    // Get campaign for response
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('id, title, slug, raised_amount, goal_amount')
      .eq('id', donation.campaign_id)
      .single();

    res.json({
      status,
      donation: { ...donation, paystack_status: status },
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

async function logOfflineDonation(req, res) {
  try {
    const { campaign_id, donor_name, amount, note, donated_at } = req.body;
    const creator_id = req.user.id;
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
    res.status(500).json({ error: err.message });
  }
}

async function deleteOfflineDonation(req, res) {
  try {
    const { id } = req.params;
    const { data: od } = await supabase.from('offline_donations').select('*').eq('id', id).single();
    if (od) {
      await supabase.from('offline_donations').delete().eq('id', id);
      await supabase.rpc('decrement_campaign_raised', { p_campaign_id: od.campaign_id, p_amount: od.amount });
    }
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getOfflineDonations(req, res) {
  try {
    const { campaign_id } = req.params;
    const { data, error } = await supabase
      .from('offline_donations')
      .select('*')
      .eq('campaign_id', campaign_id)
      .order('donated_at', { ascending: false });
    if (error) throw error;
    res.json({ offline_donations: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function getDiasporaDonors(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('donations')
      .select('*')
      .eq('campaign_id', id)
      .not('donor_country', 'is', null)
      .neq('donor_currency', 'NGN')
      .order('amount', { ascending: false })
      .limit(5);
    if (error) throw error;
    res.json({ diaspora_donors: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  initiateDonation,
  verifyDonation,
  getCampaignDonations,
  logOfflineDonation,
  deleteOfflineDonation,
  getOfflineDonations,
  getDiasporaDonors,
};

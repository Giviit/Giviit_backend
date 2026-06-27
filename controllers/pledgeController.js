const { supabase } = require('../utils/supabaseClient');
const { initiateTransaction } = require('../services/paystackService');
const { getSettings } = require('../services/settingsService');

function computeNextDate(frequency) {
  const next = new Date();
  if (frequency === 'weekly') next.setDate(next.getDate() + 7);
  else if (frequency === 'biweekly') next.setDate(next.getDate() + 14);
  else next.setMonth(next.getMonth() + 1);
  return next.toISOString().split('T')[0];
}

// Creates the pledge AND charges the first installment immediately — a
// pledge is "real" only once money has actually moved, so this returns a
// Paystack authorization_url the frontend redirects to, just like a normal
// donation. Subsequent installments go through payNextInstallment below.
exports.createPledge = async (req, res, next) => {
  try {
    const { enablePledgeFeature } = await getSettings();
    if (!enablePledgeFeature) {
      return res.status(403).json({ error: 'Pledges are currently disabled on Giviit.' });
    }

    const { campaign_id, donor_name, donor_email, total_amount, installment_amount, frequency, installments_total } = req.body;
    if (!campaign_id || !donor_name || !donor_email || !total_amount || !installments_total) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const finalFrequency = frequency || 'monthly';
    const finalInstallmentAmount = Number(installment_amount) || Number(total_amount) / Number(installments_total);

    const { data: pledge, error: pledgeError } = await supabase
      .from('pledges')
      .insert({
        campaign_id,
        donor_name,
        donor_email,
        total_amount,
        installment_amount: finalInstallmentAmount,
        frequency: finalFrequency,
        installments_total,
        next_payment_date: computeNextDate(finalFrequency),
      })
      .select()
      .single();
    if (pledgeError) throw pledgeError;

    const paystackData = await initiateTransaction({
      email: donor_email,
      amount: finalInstallmentAmount,
      campaign_id,
      donor_name,
      is_anonymous: false,
      message: `Pledge installment 1/${installments_total}`,
      callbackPath: '/pledge/confirm',
    });

    await supabase.from('donations').insert({
      campaign_id,
      donor_name,
      donor_email,
      amount: finalInstallmentAmount,
      currency: 'NGN',
      is_anonymous: false,
      message: `Pledge installment 1/${installments_total}`,
      paystack_reference: paystackData.reference,
      paystack_status: 'pending',
      pledge_id: pledge.id,
      installment_number: 1,
    });

    res.json({ pledge, authorization_url: paystackData.authorization_url, reference: paystackData.reference });
  } catch (err) {
    next(err);
  }
};

exports.getCampaignPledges = async (req, res, next) => {
  try {
    const { campaign_id } = req.params;
    const { data, error } = await supabase
      .from('pledges')
      .select('*')
      .eq('campaign_id', campaign_id)
      .eq('status', 'active');
    if (error) throw error;
    res.json({ pledges: data || [], total: data?.length || 0 });
  } catch (err) {
    next(err);
  }
};

// Charges the next unpaid installment for a pledge — used both by the
// donor-facing "Pay Now" link in reminder emails and any manual retry.
exports.payNextInstallment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { data: pledge, error } = await supabase.from('pledges').select('*').eq('id', id).single();
    if (error || !pledge) return res.status(404).json({ error: 'Pledge not found' });
    if (pledge.status !== 'active') return res.status(400).json({ error: `This pledge is ${pledge.status}, not active.` });

    const installmentNumber = Number(pledge.installments_paid || 0) + 1;
    if (installmentNumber > Number(pledge.installments_total)) {
      return res.status(400).json({ error: 'This pledge has already been fully paid.' });
    }

    const result = await initiateTransaction({
      email: pledge.donor_email,
      amount: pledge.installment_amount,
      campaign_id: pledge.campaign_id,
      donor_name: pledge.donor_name,
      is_anonymous: false,
      message: `Pledge installment ${installmentNumber}/${pledge.installments_total}`,
      callbackPath: '/pledge/confirm',
    });

    await supabase.from('donations').insert({
      campaign_id: pledge.campaign_id,
      donor_name: pledge.donor_name,
      donor_email: pledge.donor_email,
      amount: pledge.installment_amount,
      currency: 'NGN',
      is_anonymous: false,
      message: `Pledge installment ${installmentNumber}/${pledge.installments_total}`,
      paystack_reference: result.reference,
      paystack_status: 'pending',
      pledge_id: pledge.id,
      installment_number: installmentNumber,
    });

    res.json({ authorization_url: result.authorization_url, reference: result.reference });
  } catch (err) {
    next(err);
  }
};

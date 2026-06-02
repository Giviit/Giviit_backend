const { supabase } = require('../utils/supabaseClient');
const { initiateTransaction } = require('../services/paystackService');

exports.createPledge = async (req, res) => {
  try {
    const { campaign_id, donor_name, donor_email, total_amount, installment_amount, frequency, installments_total } = req.body;
    if (!campaign_id || !donor_name || !donor_email || !total_amount || !installments_total) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const today = new Date();
    const next = new Date(today);
    if (frequency === 'weekly') next.setDate(next.getDate() + 7);
    else if (frequency === 'biweekly') next.setDate(next.getDate() + 14);
    else next.setMonth(next.getMonth() + 1);

    const { data, error } = await supabase
      .from('pledges')
      .insert({
        campaign_id,
        donor_name,
        donor_email,
        total_amount,
        installment_amount: installment_amount || total_amount / installments_total,
        frequency: frequency || 'monthly',
        installments_total,
        next_payment_date: next.toISOString().split('T')[0],
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ pledge: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getCampaignPledges = async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
};

exports.payNextInstallment = async (req, res) => {
  try {
    const { id } = req.params;
    const { data: pledge, error } = await supabase.from('pledges').select('*').eq('id', id).single();
    if (error || !pledge) return res.status(404).json({ error: 'Pledge not found' });

    const result = await initiateTransaction({
      email: pledge.donor_email,
      amount: pledge.installment_amount,
      campaign_id: pledge.campaign_id,
      donor_name: pledge.donor_name,
      donor_email: pledge.donor_email,
      is_anonymous: false,
      message: `Pledge installment payment (pledge id: ${id})`,
    });
    res.json({ authorization_url: result.authorization_url, reference: result.reference });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

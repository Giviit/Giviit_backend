const { supabase } = require('../utils/supabaseClient');
const email = require('./emailService');

// Overfunding is disallowed platform-wide. A donation that would push a
// campaign's raised_amount past its goal is capped at the remaining balance —
// the donor is only ever charged up to what's left to reach the goal.
function capAmount(requestedAmount, previousRaised, goalAmount) {
  if (!goalAmount) return { cappedAmount: requestedAmount, excessAmount: 0 };
  const remaining = Math.max(goalAmount - previousRaised, 0);
  const cappedAmount = Math.min(requestedAmount, remaining);
  return { cappedAmount, excessAmount: Math.max(requestedAmount - cappedAmount, 0) };
}

// Call once the campaign's raised_amount has been updated to newRaised using
// the CAPPED amount (see capAmount above). Closes the campaign the moment it
// hits its goal and notifies the creator + every distinct donor.
async function handleGoalReached({ campaign, newRaised }) {
  const goalAmount = Number(campaign.goal_amount) || 0;
  if (!goalAmount || campaign.goal_reached_at || newRaised < goalAmount) return;

  await supabase.from('campaigns').update({
    status: 'completed',
    goal_reached_at: new Date().toISOString(),
  }).eq('id', campaign.id);

  const campaignUrl = `${process.env.FRONTEND_URL}/campaign/${campaign.slug || ''}`;
  const { data: creator } = await supabase.from('profiles').select('email').eq('id', campaign.creator_id).single();
  if (creator?.email) {
    try {
      await email.goalReached(creator.email, {
        campaign_title: campaign.title,
        goal_amount: goalAmount,
        raised_amount: newRaised,
        campaign_url: campaignUrl,
      });
    } catch {}
  }

  const { data: donations } = await supabase
    .from('donations')
    .select('donor_email')
    .eq('campaign_id', campaign.id)
    .eq('paystack_status', 'success');
  const seen = new Set();
  for (const d of donations || []) {
    if (!d.donor_email || seen.has(d.donor_email)) continue;
    seen.add(d.donor_email);
    try {
      await email.donorGoalReached(d.donor_email, { campaign_title: campaign.title });
    } catch {}
  }
}

module.exports = { capAmount, handleGoalReached };

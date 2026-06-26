const { supabase } = require('../utils/supabaseClient');

// Risk score >= this threshold holds the campaign for manual admin approval
// instead of letting it go live immediately.
const RISK_THRESHOLD = 50;

// Classic advance-fee / 419 / investment-scam language. Matching any of these
// in the campaign title, description, or story adds significant risk weight.
const SCAM_KEYWORDS = [
  'western union', 'moneygram', 'wire transfer to', 'next of kin', 'inheritance fund',
  'lottery winning', 'investment return', 'double your money', 'guaranteed profit',
  'forex trading bot', 'bitcoin doubling', 'crypto giveaway', 'send your bank pin',
  'processing fee to release', 'advance fee', 'click this link to claim',
  'urgent business proposal', 'beneficiary of', 'unclaimed fund',
];

// Rule-based pattern recognition over a candidate campaign + its creator profile.
// Returns a risk score and the specific reasons that contributed to it, so
// admins reviewing a hold can see exactly what tripped it.
async function assessCampaignRisk({ campaign, creator }) {
  const reasons = [];
  let score = 0;

  const goalAmount = Number(campaign.goal_amount) || 0;
  const accountAgeHours = (Date.now() - new Date(creator.created_at).getTime()) / (1000 * 60 * 60);

  // 1. Brand-new account asking for a large amount
  if (accountAgeHours < 24 && goalAmount > 1000000) {
    score += 30;
    reasons.push({ flag_type: 'NEW_ACCOUNT_HIGH_GOAL', details: `Account is ${accountAgeHours.toFixed(1)}h old, campaign goal is ₦${goalAmount.toLocaleString()}` });
  }

  // 2. Identity not yet verified, but asking for a large amount
  if (creator.verification_status !== 'verified' && goalAmount > 2000000) {
    score += 25;
    reasons.push({ flag_type: 'UNVERIFIED_HIGH_GOAL', details: `Creator identity is not verified, campaign goal is ₦${goalAmount.toLocaleString()}` });
  }

  // 3. Urgency + new account + meaningful goal — classic pressure-scam combo
  if (campaign.is_urgent && accountAgeHours < 72 && goalAmount > 500000) {
    score += 20;
    reasons.push({ flag_type: 'URGENCY_PRESSURE_PATTERN', details: 'Marked urgent, from a recently created account, with a substantial goal' });
  }

  // 4. Blacklisted scam keywords in the campaign text
  const text = `${campaign.title || ''} ${campaign.description || ''} ${campaign.story || ''}`.toLowerCase();
  const matchedKeywords = SCAM_KEYWORDS.filter(k => text.includes(k));
  if (matchedKeywords.length) {
    score += 40;
    reasons.push({ flag_type: 'SCAM_KEYWORDS', details: `Matched known scam language: ${matchedKeywords.join(', ')}` });
  }

  // 5. Velocity — same creator launching many campaigns in a short window
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count: recentCampaignCount } = await supabase
    .from('campaigns')
    .select('*', { count: 'exact', head: true })
    .eq('creator_id', creator.id)
    .gte('created_at', sevenDaysAgo);
  if ((recentCampaignCount || 0) >= 3) {
    score += 25;
    reasons.push({ flag_type: 'CAMPAIGN_VELOCITY', details: `${recentCampaignCount} campaigns created by this account in the last 7 days` });
  }

  // 6. Duplicate / templated title reused from a different creator
  if (campaign.title) {
    const { data: titleMatches } = await supabase
      .from('campaigns')
      .select('id')
      .ilike('title', campaign.title)
      .neq('creator_id', creator.id)
      .limit(1);
    if (titleMatches?.length) {
      score += 20;
      reasons.push({ flag_type: 'DUPLICATE_TITLE', details: 'An identical campaign title already exists from a different creator' });
    }
  }

  // 7. Bank account reused across multiple accounts — identity-reuse / fraud-ring pattern
  if (creator.bank_account_number) {
    const { count: sharedBankCount } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .eq('bank_account_number', creator.bank_account_number)
      .neq('id', creator.id);
    if ((sharedBankCount || 0) > 0) {
      score += 35;
      reasons.push({ flag_type: 'SHARED_BANK_ACCOUNT', details: 'This bank account number is shared with another Giviit account' });
    }
  }

  // 8. No cover image — low-effort / spam signal (minor weight on its own)
  if (!campaign.cover_image) {
    score += 5;
    reasons.push({ flag_type: 'NO_COVER_IMAGE', details: 'Submitted without a cover image' });
  }

  return { score, reasons, requiresReview: score >= RISK_THRESHOLD };
}

module.exports = { assessCampaignRisk, RISK_THRESHOLD, SCAM_KEYWORDS };

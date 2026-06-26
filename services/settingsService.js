const { supabase } = require('../utils/supabaseClient');

const ROW_TO_CAMEL = {
  platform_fee_percent: 'platformFeePercent',
  min_withdrawal_amount: 'minWithdrawalAmount',
  max_campaign_goal: 'maxCampaignGoal',
  campaign_review_period_days: 'campaignReviewPeriodDays',
  allow_new_registrations: 'allowNewRegistrations',
  require_kyc_for_withdrawal: 'requireKycForWithdrawal',
  maintenance_mode: 'maintenanceMode',
  enable_pledge_feature: 'enablePledgeFeature',
  enable_offline_donations: 'enableOfflineDonations',
  email_from_address: 'emailFromAddress',
  email_support_address: 'emailSupportAddress',
  email_on_new_campaign: 'emailOnNewCampaign',
  email_on_withdrawal: 'emailOnWithdrawal',
  email_on_fraud_flag: 'emailOnFraudFlag',
};
const CAMEL_TO_ROW = Object.fromEntries(Object.entries(ROW_TO_CAMEL).map(([k, v]) => [v, k]));

function toCamel(row) {
  const out = {};
  for (const [snake, camel] of Object.entries(ROW_TO_CAMEL)) out[camel] = row[snake];
  return out;
}

// Settings are read on hot paths (registration, donation, withdrawal) so a
// short-lived cache avoids a DB round trip per request without risking a
// stale flag for more than a few seconds after an admin saves a change.
let cache = null;
let cacheAt = 0;
const CACHE_MS = 10000;

async function getSettings() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;

  const { data, error } = await supabase.from('platform_settings').select('*').eq('id', 1).single();
  if (error || !data) throw new Error('Platform settings not found — run database/008_platform_settings.sql');

  cache = toCamel(data);
  cacheAt = Date.now();
  return cache;
}

async function updateSettings(patch, userId) {
  const row = { updated_at: new Date().toISOString(), updated_by: userId || null };
  for (const [camel, value] of Object.entries(patch)) {
    const snake = CAMEL_TO_ROW[camel];
    if (snake) row[snake] = value;
  }

  const { data, error } = await supabase
    .from('platform_settings')
    .update(row)
    .eq('id', 1)
    .select()
    .single();
  if (error) throw error;

  cache = toCamel(data);
  cacheAt = Date.now();
  return cache;
}

module.exports = { getSettings, updateSettings };

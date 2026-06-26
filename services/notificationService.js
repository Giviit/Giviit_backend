const { supabase } = require('../utils/supabaseClient');

async function notifyAdmins({ type, title, message, link, campaignId }) {
  try {
    await supabase.from('notifications').insert({
      type,
      title,
      message: message || null,
      link: link || null,
      campaign_id: campaignId || null,
    });
  } catch {}
}

module.exports = { notifyAdmins };

const { supabase } = require('../utils/supabaseClient');
const email = require('./emailService');

const REMINDER_LOOKAHEAD_DAYS = 2;

// Finds active pledges whose next installment is due within the lookahead
// window (or already overdue) and emails a reminder with a link to pay it.
// Guarded by last_reminder_sent_at so a pledge only gets one reminder per
// day even if this job runs more than once — see server.js for the schedule.
async function sendDuePledgeReminders() {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const lookahead = new Date(today.getTime() + REMINDER_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().split('T')[0];

  const { data: pledges, error } = await supabase
    .from('pledges')
    .select('*, campaign:campaigns(title)')
    .eq('status', 'active')
    .lte('next_payment_date', lookahead);

  if (error) {
    console.error('[pledge-reminder] Failed to load due pledges:', error.message);
    return;
  }

  for (const pledge of pledges || []) {
    if (pledge.last_reminder_sent_at && pledge.last_reminder_sent_at.slice(0, 10) === todayStr) continue;

    try {
      await email.pledgeReminder(pledge.donor_email, {
        donor_name: pledge.donor_name,
        campaign_title: pledge.campaign?.title || 'the campaign',
        installment_amount: pledge.installment_amount,
        installment_number: Number(pledge.installments_paid || 0) + 1,
        installments_total: pledge.installments_total,
        due_date: pledge.next_payment_date,
        pay_url: `${process.env.FRONTEND_URL}/pledge/${pledge.id}/pay`,
      });
      await supabase.from('pledges').update({ last_reminder_sent_at: new Date().toISOString() }).eq('id', pledge.id);
    } catch (err) {
      console.error('[pledge-reminder] Failed for pledge', pledge.id, err.message);
    }
  }
}

module.exports = { sendDuePledgeReminders };

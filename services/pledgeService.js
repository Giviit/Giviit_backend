const { supabase } = require('../utils/supabaseClient');

function nextDateFrom(date, frequency) {
  const next = new Date(date);
  if (frequency === 'weekly') next.setDate(next.getDate() + 7);
  else if (frequency === 'biweekly') next.setDate(next.getDate() + 14);
  else next.setMonth(next.getMonth() + 1);
  return next.toISOString().split('T')[0];
}

// Called once an installment's underlying donation has actually been paid.
// Advances the pledge's progress and schedules (or clears) the next payment
// date — computed from today rather than the previous due date, so a late
// payment doesn't immediately leave the next reminder overdue.
async function advancePledge(pledgeId) {
  const { data: pledge } = await supabase.from('pledges').select('*').eq('id', pledgeId).single();
  if (!pledge) return null;

  const installmentsPaid = Number(pledge.installments_paid || 0) + 1;
  const completed = installmentsPaid >= Number(pledge.installments_total);

  const updates = {
    installments_paid: installmentsPaid,
    status: completed ? 'completed' : 'active',
    next_payment_date: completed ? null : nextDateFrom(new Date(), pledge.frequency),
    last_reminder_sent_at: null,
  };

  const { data, error } = await supabase.from('pledges').update(updates).eq('id', pledgeId).select().single();
  if (error) throw error;
  return data;
}

module.exports = { advancePledge, nextDateFrom };

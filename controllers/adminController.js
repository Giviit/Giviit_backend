const { supabase } = require('../utils/supabaseClient');
const paystack = require('../services/paystackService');
const email = require('../services/emailService');
const { logAudit } = require('../utils/auditLog');
const { reconcileMasterAccount } = require('../services/ledgerService');

async function dashboardStats(req, res, next) {
  try {
    const [
      { count: totalCampaigns },
      { count: totalDonations },
      { data: donationAmounts },
      { count: pendingVerifications },
      { count: pendingWithdrawals },
      { count: openReports },
      { count: totalUsers },
      { count: pendingKyc },
    ] = await Promise.all([
      supabase.from('campaigns').select('*', { count: 'exact', head: true }),
      supabase.from('donations').select('*', { count: 'exact', head: true }).eq('paystack_status', 'success'),
      supabase.from('donations').select('amount').eq('paystack_status', 'success'),
      supabase.from('campaigns').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('withdrawals').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('profiles').select('*', { count: 'exact', head: true }),
      supabase.from('kyc_verifications').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    ]);

    const total_raised = (donationAmounts || []).reduce((s, d) => s + Number(d.amount || 0), 0);
    const platform_fees = total_raised * 0.03;

    const { data: recent_campaigns } = await supabase
      .from('campaigns')
      .select('id, title, cover_image, status, created_at, creator:profiles(full_name)')
      .order('created_at', { ascending: false })
      .limit(5);

    const { count: fraudFlagCount } = await supabase
      .from('fraud_flags')
      .select('*', { count: 'exact', head: true })
      .eq('is_resolved', false);

    res.json({
      total_campaigns: totalCampaigns || 0,
      total_donations: totalDonations || 0,
      total_raised,
      platform_fees,
      pending_verifications: pendingVerifications || 0,
      pending_withdrawals: pendingWithdrawals || 0,
      open_reports: openReports || 0,
      total_users: totalUsers || 0,
      pending_kyc: pendingKyc || 0,
      unresolved_fraud_flags: fraudFlagCount || 0,
      recent_campaigns: recent_campaigns || [],
    });
  } catch (err) {
    next(err);
  }
}

async function getAllCampaigns(req, res, next) {
  try {
    const { status, category, search, page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let query = supabase
      .from('campaigns')
      .select('*, creator:profiles(id,full_name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);
    if (status) query = query.eq('status', status);
    if (category) query = query.eq('category', category);
    if (search) query = query.ilike('title', `%${search}%`);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ campaigns: data || [], total: count || 0 });
  } catch (err) {
    next(err);
  }
}

async function verifyCampaign(req, res, next) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('campaigns')
      .update({ is_verified: true, status: 'active', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, creator:profiles(email,full_name)')
      .single();
    if (error) throw error;

    await logAudit({ action: 'CAMPAIGN_APPROVED', entityType: 'campaign', entityId: id, performedBy: req.user.id });

    try {
      const campaignUrl = `${process.env.FRONTEND_URL}/campaign/${data.slug}`;
      await email.campaignApproved(data.creator.email, { campaign_title: data.title, campaign_url: campaignUrl });
    } catch {}

    res.json({ campaign: data });
  } catch (err) {
    next(err);
  }
}

async function rejectCampaign(req, res, next) {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const { data, error } = await supabase
      .from('campaigns')
      .update({ status: 'rejected', rejection_note: note, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, creator:profiles(email)')
      .single();
    if (error) throw error;

    await logAudit({ action: 'CAMPAIGN_REJECTED', entityType: 'campaign', entityId: id, performedBy: req.user.id, metadata: { note } });

    try {
      await email.campaignRejected(data.creator.email, { campaign_title: data.title, reason: note });
    } catch {}

    res.json({ campaign: data });
  } catch (err) {
    next(err);
  }
}

async function freezeCampaign(req, res, next) {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    await supabase.from('campaigns').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', id);
    await supabase.from('fraud_flags').insert({ campaign_id: id, flag_type: 'ADMIN_FREEZE', details: reason || 'Frozen by admin' });
    await logAudit({ action: 'CAMPAIGN_FROZEN', entityType: 'campaign', entityId: id, performedBy: req.user.id, metadata: { reason } });

    res.json({ message: 'Campaign frozen' });
  } catch (err) {
    next(err);
  }
}

async function markFraudulent(req, res, next) {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    await supabase.from('campaigns').update({ status: 'fraudulent', updated_at: new Date().toISOString() }).eq('id', id);

    // Cancel all pending withdrawals
    await supabase.from('withdrawals').update({ status: 'reversed' }).eq('campaign_id', id).in('status', ['pending', 'processing']);

    // Get all successful donations and refund
    const { data: donations } = await supabase
      .from('donations')
      .select('*')
      .eq('campaign_id', id)
      .eq('paystack_status', 'success');

    let refundsInitiated = 0;
    let totalRefunded = 0;

    const { data: campaign } = await supabase.from('campaigns').select('title, creator_id').eq('id', id).single();

    for (const donation of donations || []) {
      try {
        await paystack.initiateRefund({ transaction: donation.paystack_reference });
        await supabase.from('refunds').insert({
          donation_id: donation.id,
          campaign_id: id,
          amount: donation.amount,
          reason: reason || 'Campaign marked as fraudulent',
          status: 'processing',
          initiated_by: req.user.id,
        });
        refundsInitiated++;
        totalRefunded += Number(donation.amount);

        await email.campaignFraudulent(donation.donor_email, {
          campaign_title: campaign?.title || 'the campaign',
          amount: donation.amount,
        });
      } catch {}
    }

    // Ban creator
    if (campaign?.creator_id) {
      await supabase.from('profiles').update({ is_banned: true }).eq('id', campaign.creator_id);
    }

    await logAudit({
      action: 'CAMPAIGN_FRAUDULENT',
      entityType: 'campaign',
      entityId: id,
      performedBy: req.user.id,
      metadata: { reason, refundsInitiated, totalRefunded },
    });

    res.json({ message: 'Campaign marked fraudulent', refunds_initiated: refundsInitiated, total_refunded: totalRefunded });
  } catch (err) {
    next(err);
  }
}

async function toggleFeature(req, res, next) {
  try {
    const { id } = req.params;
    const { data: c } = await supabase.from('campaigns').select('is_featured').eq('id', id).single();
    const { data, error } = await supabase.from('campaigns').update({ is_featured: !c.is_featured }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ campaign: data });
  } catch (err) {
    next(err);
  }
}

async function toggleUrgent(req, res, next) {
  try {
    const { id } = req.params;
    const { data: c } = await supabase.from('campaigns').select('is_urgent').eq('id', id).single();
    const { data, error } = await supabase.from('campaigns').update({ is_urgent: !c.is_urgent }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ campaign: data });
  } catch (err) {
    next(err);
  }
}

async function getWithdrawals(req, res, next) {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let query = supabase
      .from('withdrawals')
      .select('*, campaign:campaigns(id,title), creator:profiles(id,full_name,email)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);
    if (status) query = query.eq('status', status);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ withdrawals: data || [], total: count || 0 });
  } catch (err) {
    next(err);
  }
}

async function approveWithdrawal(req, res, next) {
  try {
    const { id } = req.params;
    const { data: withdrawal, error: wErr } = await supabase
      .from('withdrawals')
      .select('*, creator:profiles(email,full_name)')
      .eq('id', id)
      .single();
    if (wErr) throw wErr;
    if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Withdrawal is not pending' });

    await supabase.from('withdrawals').update({ status: 'processing' }).eq('id', id);

    // Create recipient if needed
    let recipientCode = withdrawal.paystack_recipient_code;
    if (!recipientCode) {
      const recipient = await paystack.createTransferRecipient({
        name: withdrawal.account_name,
        account_number: withdrawal.account_number,
        bank_code: withdrawal.bank_code,
      });
      recipientCode = recipient.recipient_code;
      await supabase.from('withdrawals').update({ paystack_recipient_code: recipientCode }).eq('id', id);
    }

    const transferRef = `GIVIIT_WD_${id.slice(0, 8)}_${Date.now()}`;
    const { data: campaign } = await supabase.from('campaigns').select('title').eq('id', withdrawal.campaign_id).single();

    const transfer = await paystack.transferToRecipient({
      amount: withdrawal.amount,
      recipient: recipientCode,
      reason: `Giviit withdrawal — ${campaign?.title || id}`,
      reference: transferRef,
    });

    await supabase.from('withdrawals').update({
      status: 'processing',
      paystack_transfer_code: transfer.transfer_code,
      paystack_transfer_reference: transferRef,
      updated_at: new Date().toISOString(),
    }).eq('id', id);

    await logAudit({ action: 'WITHDRAWAL_APPROVED', entityType: 'withdrawal', entityId: id, performedBy: req.user.id, metadata: { amount: withdrawal.amount } });

    const bankLast4 = String(withdrawal.account_number).slice(-4);
    try {
      await email.withdrawalProcessing(withdrawal.creator?.email, { amount: withdrawal.amount, bank_last4: bankLast4 });
    } catch {}

    res.json({ message: 'Transfer initiated', transfer_code: transfer.transfer_code });
  } catch (err) {
    await supabase.from('withdrawals').update({ status: 'failed', admin_note: err.message }).eq('id', req.params.id).catch(() => {});
    next(err);
  }
}

async function rejectWithdrawal(req, res, next) {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const { data, error } = await supabase
      .from('withdrawals')
      .update({ status: 'failed', admin_note: note || 'Rejected by admin', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, creator:profiles(email)')
      .single();
    if (error) throw error;

    await logAudit({ action: 'WITHDRAWAL_REJECTED', entityType: 'withdrawal', entityId: id, performedBy: req.user.id, metadata: { note } });

    try {
      await email.withdrawalFailed(data.creator?.email, { amount: data.amount, reason: note });
    } catch {}

    res.json({ withdrawal: data });
  } catch (err) {
    next(err);
  }
}

async function getReports(req, res, next) {
  try {
    const { status } = req.query;
    let query = supabase
      .from('reports')
      .select('*, campaign:campaigns(id,title,slug)')
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ reports: data || [] });
  } catch (err) {
    next(err);
  }
}

async function reviewReport(req, res, next) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('reports').update({ status: 'reviewed' }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ report: data });
  } catch (err) {
    next(err);
  }
}

async function dismissReport(req, res, next) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('reports').update({ status: 'dismissed' }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ report: data });
  } catch (err) {
    next(err);
  }
}

async function getUsers(req, res, next) {
  try {
    const { search } = req.query;
    let query = supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (search) query = query.ilike('full_name', `%${search}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ users: data || [] });
  } catch (err) {
    next(err);
  }
}

async function banUser(req, res, next) {
  try {
    const { id } = req.params;
    await supabase.from('profiles').update({ is_banned: true }).eq('id', id);
    await supabase.from('campaigns').update({ status: 'paused' }).eq('creator_id', id).eq('status', 'active');
    await logAudit({ action: 'USER_BANNED', entityType: 'profile', entityId: id, performedBy: req.user.id });
    res.json({ message: 'User banned' });
  } catch (err) {
    next(err);
  }
}

async function unbanUser(req, res, next) {
  try {
    const { id } = req.params;
    await supabase.from('profiles').update({ is_banned: false }).eq('id', id);
    await logAudit({ action: 'USER_UNBANNED', entityType: 'profile', entityId: id, performedBy: req.user.id });
    res.json({ message: 'User unbanned' });
  } catch (err) {
    next(err);
  }
}

async function changeUserRole(req, res, next) {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const { data, error } = await supabase.from('profiles').update({ role }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ user: data });
  } catch (err) {
    next(err);
  }
}

async function getAllKyc(req, res, next) {
  try {
    const { status } = req.query;
    let query = supabase
      .from('kyc_verifications')
      .select('*, profiles(id,full_name,email)')
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ kyc_verifications: data || [] });
  } catch (err) {
    next(err);
  }
}

async function manualApproveKyc(req, res, next) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('kyc_verifications')
      .update({ status: 'verified', verified_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, profiles(email)')
      .single();
    if (error) throw error;

    await logAudit({ action: 'KYC_MANUAL_APPROVED', entityType: 'kyc', entityId: id, performedBy: req.user.id });

    try {
      await email.kycVerified(data.profiles?.email);
    } catch {}

    res.json({ kyc: data });
  } catch (err) {
    next(err);
  }
}

async function getFraudFlags(req, res, next) {
  try {
    const { data, error } = await supabase
      .from('fraud_flags')
      .select('*, campaign:campaigns(id,title,slug,status)')
      .eq('is_resolved', false)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ fraud_flags: data || [] });
  } catch (err) {
    next(err);
  }
}

async function resolveFraudFlag(req, res, next) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('fraud_flags')
      .update({ is_resolved: true })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    await logAudit({ action: 'FRAUD_FLAG_RESOLVED', entityType: 'fraud_flag', entityId: id, performedBy: req.user.id });
    res.json({ fraud_flag: data });
  } catch (err) {
    next(err);
  }
}

async function getAuditLogs(req, res, next) {
  try {
    const { page = 1, limit = 50, entity_type } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    let query = supabase
      .from('audit_logs')
      .select('*, performed_by_profile:profiles(full_name)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);
    if (entity_type) query = query.eq('entity_type', entity_type);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ audit_logs: data || [], total: count || 0 });
  } catch (err) {
    next(err);
  }
}

async function getLedger(req, res, next) {
  try {
    const ledger = await reconcileMasterAccount();
    res.json({ ledger });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  dashboardStats,
  getAllCampaigns,
  verifyCampaign,
  rejectCampaign,
  freezeCampaign,
  markFraudulent,
  toggleFeature,
  toggleUrgent,
  getWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  getReports,
  reviewReport,
  dismissReport,
  getUsers,
  banUser,
  unbanUser,
  changeUserRole,
  getAllKyc,
  manualApproveKyc,
  getFraudFlags,
  resolveFraudFlag,
  getAuditLogs,
  getLedger,
};

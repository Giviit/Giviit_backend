const { supabase } = require('../utils/supabaseClient');
const paystack = require('../services/paystackService');
const email = require('../services/emailService');
const { logAudit } = require('../utils/auditLog');
const { reconcileMasterAccount, recordRefundEntry } = require('../services/ledgerService');
const { RISK_THRESHOLD } = require('../services/fraudDetectionService');

const STRIKE_LIMIT = 3;

// Adds one confirmed-fraud strike to a creator and auto-bans them once they
// hit STRIKE_LIMIT. Only call this for admin-confirmed fraud, not for raw
// algorithmic flags (those can be false positives and shouldn't count).
async function addFraudStrike(creatorId, reason) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, full_name, fraud_strike_count, is_banned')
    .eq('id', creatorId)
    .single();
  if (!profile || profile.is_banned) return;

  const newCount = (profile.fraud_strike_count || 0) + 1;
  const updates = { fraud_strike_count: newCount };

  if (newCount >= STRIKE_LIMIT) {
    updates.is_banned = true;
    updates.ban_reason = `Reached ${STRIKE_LIMIT} confirmed fraud strikes`;
    updates.banned_at = new Date().toISOString();
  }

  await supabase.from('profiles').update(updates).eq('id', creatorId);

  if (newCount >= STRIKE_LIMIT) {
    await supabase.from('campaigns').update({ status: 'paused' }).eq('creator_id', creatorId).eq('status', 'active');
    await logAudit({ action: 'USER_BANNED', entityType: 'profile', entityId: creatorId, metadata: { reason: updates.ban_reason, auto: true } });
    try {
      await email.accountBanned(profile.email, { reason: updates.ban_reason });
    } catch {}
  }
}

async function dashboardStats(req, res, next) {
  try {
    const [
      { count: totalCampaigns },
      { count: totalDonations },
      { data: donationAmounts },
      { count: pendingVerifications },
      { count: flaggedWithdrawals },
      { count: openReports },
      { count: totalUsers },
      { count: pendingKyc },
    ] = await Promise.all([
      supabase.from('campaigns').select('*', { count: 'exact', head: true }),
      supabase.from('donations').select('*', { count: 'exact', head: true }).eq('paystack_status', 'success'),
      supabase.from('donations').select('amount').eq('paystack_status', 'success'),
      supabase.from('campaigns').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      // Withdrawals fire autonomously now (no admin approval gate), so the
      // dashboard's old "pending withdrawals" count is replaced with flagged
      // ones — that's the only withdrawal state still awaiting admin action.
      supabase.from('withdrawals').select('*', { count: 'exact', head: true }).eq('is_flagged', true),
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
      flagged_withdrawals: flaggedWithdrawals || 0,
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
    const { data: existing } = await supabase.from('campaigns').select('appeal_status').eq('id', id).single();

    const updates = { is_verified: true, status: 'active', updated_at: new Date().toISOString() };
    if (existing?.appeal_status === 'pending') {
      updates.appeal_status = 'approved';
      updates.appeal_reviewed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('campaigns')
      .update(updates)
      .eq('id', id)
      .select('*, creator:profiles(email,full_name)')
      .single();
    if (error) throw error;

    await supabase.from('fraud_flags').update({ is_resolved: true }).eq('campaign_id', id).eq('is_resolved', false);

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

    const { data: existing } = await supabase.from('campaigns').select('appeal_status, fraud_risk_score, creator_id').eq('id', id).single();

    const updates = { status: 'rejected', rejection_note: note, updated_at: new Date().toISOString() };
    if (existing?.appeal_status === 'pending') {
      updates.appeal_status = 'rejected';
      updates.appeal_reviewed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('campaigns')
      .update(updates)
      .eq('id', id)
      .select('*, creator:profiles(email)')
      .single();
    if (error) throw error;

    await supabase.from('fraud_flags').update({ is_resolved: true }).eq('campaign_id', id).eq('is_resolved', false);

    await logAudit({ action: 'CAMPAIGN_REJECTED', entityType: 'campaign', entityId: id, performedBy: req.user.id, metadata: { note } });

    try {
      await email.campaignRejected(data.creator.email, { campaign_title: data.title, reason: note });
    } catch {}

    // This campaign came through fraud review and admin just confirmed it
    // was actually bad — counts as one confirmed-fraud strike on the creator.
    if ((existing?.fraud_risk_score || 0) >= RISK_THRESHOLD && existing?.creator_id) {
      await addFraudStrike(existing.creator_id, `Campaign "${data.title}" rejected after fraud review`);
    }

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
        const refund = await paystack.initiateRefund({ transaction: donation.paystack_reference });
        const { data: refundRow } = await supabase.from('refunds').insert({
          donation_id: donation.id,
          campaign_id: id,
          amount: donation.amount,
          reason: reason || 'Campaign marked as fraudulent',
          status: 'processing',
          paystack_refund_reference: refund?.id ? String(refund.id) : null,
          initiated_by: req.user.id,
        }).select().single();

        if (campaign?.creator_id && refundRow) {
          try {
            await recordRefundEntry({
              userId: campaign.creator_id,
              campaignId: id,
              amount: donation.amount,
              refundId: refundRow.id,
              paystackReference: donation.paystack_reference,
            });
          } catch (err) {
            console.error('[ledger] Failed to record refund entry:', err.message);
          }
        }

        refundsInitiated++;
        totalRefunded += Number(donation.amount);

        await email.campaignFraudulent(donation.donor_email, {
          campaign_title: campaign?.title || 'the campaign',
          amount: donation.amount,
        });
      } catch {}
    }

    // Ban creator immediately — confirmed fraud is severe enough to skip the strike count
    if (campaign?.creator_id) {
      const { data: creatorProfile } = await supabase
        .from('profiles').select('fraud_strike_count').eq('id', campaign.creator_id).single();
      await supabase.from('profiles').update({
        is_banned: true,
        ban_reason: reason || 'Campaign marked as fraudulent',
        banned_at: new Date().toISOString(),
        fraud_strike_count: (creatorProfile?.fraud_strike_count || 0) + 1,
      }).eq('id', campaign.creator_id);
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

// Withdrawals fire their Paystack transfer the instant a creator submits
// them (see requestWithdrawal in withdrawalController.js) — there is no
// admin approval gate any more. This is the one action admins retain: flag
// a withdrawal as suspicious for the record. It does NOT pull back a
// transfer that already went out (Paystack has no cancel-in-flight API for
// a transfer once submitted) and does NOT ban the creator on its own —
// that's a separate, deliberate admin action via the existing ban flow if
// the flagged withdrawal warrants it.
async function flagWithdrawal(req, res, next) {
  try {
    const { id } = req.params;
    const { note } = req.body;
    const { data, error } = await supabase
      .from('withdrawals')
      .update({ is_flagged: true, admin_note: note || 'Flagged by admin for review', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*, creator:profiles(id,email,full_name)')
      .single();
    if (error) throw error;

    await logAudit({ action: 'WITHDRAWAL_FLAGGED', entityType: 'withdrawal', entityId: id, performedBy: req.user.id, metadata: { note } });

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
    const { reason } = req.body;
    await supabase.from('profiles').update({
      is_banned: true,
      ban_reason: reason || 'Banned by admin',
      banned_at: new Date().toISOString(),
    }).eq('id', id);
    await supabase.from('campaigns').update({ status: 'paused' }).eq('creator_id', id).eq('status', 'active');
    await logAudit({ action: 'USER_BANNED', entityType: 'profile', entityId: id, performedBy: req.user.id, metadata: { reason } });
    res.json({ message: 'User banned' });
  } catch (err) {
    next(err);
  }
}

async function unbanUser(req, res, next) {
  try {
    const { id } = req.params;
    await supabase.from('profiles').update({
      is_banned: false,
      ban_appeal_status: 'none',
    }).eq('id', id);
    await logAudit({ action: 'USER_UNBANNED', entityType: 'profile', entityId: id, performedBy: req.user.id });
    res.json({ message: 'User unbanned' });
  } catch (err) {
    next(err);
  }
}

async function getBanAppeals(req, res, next) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, is_banned, ban_reason, banned_at, fraud_strike_count, ban_appeal_message, ban_appeal_status, ban_appeal_submitted_at')
      .eq('ban_appeal_status', 'pending')
      .order('ban_appeal_submitted_at', { ascending: false });
    if (error) throw error;
    res.json({ ban_appeals: data || [] });
  } catch (err) {
    next(err);
  }
}

async function resolveBanAppeal(req, res, next) {
  try {
    const { id } = req.params;
    const { approve, note } = req.body;

    const { data: profile, error: getError } = await supabase.from('profiles').select('email').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'User not found' });

    if (approve) {
      await supabase.from('profiles').update({ is_banned: false, ban_appeal_status: 'approved' }).eq('id', id);
      try { await email.banAppealApproved(profile.email); } catch {}
    } else {
      await supabase.from('profiles').update({ ban_appeal_status: 'rejected' }).eq('id', id);
      try { await email.banAppealRejected(profile.email, { note }); } catch {}
    }

    await logAudit({ action: approve ? 'BAN_APPEAL_APPROVED' : 'BAN_APPEAL_REJECTED', entityType: 'profile', entityId: id, performedBy: req.user.id, metadata: { note } });

    res.json({ message: approve ? 'User unbanned' : 'Appeal rejected' });
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

async function getReviewQueue(req, res, next) {
  try {
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select('*, creator:profiles(id,full_name,email,verification_status)')
      .eq('status', 'pending')
      .order('fraud_risk_score', { ascending: false });
    if (error) throw error;

    const ids = (campaigns || []).map(c => c.id);
    let flagsByCampaign = {};
    if (ids.length) {
      const { data: flags } = await supabase
        .from('fraud_flags')
        .select('*')
        .in('campaign_id', ids)
        .eq('is_resolved', false);
      flagsByCampaign = (flags || []).reduce((acc, f) => {
        (acc[f.campaign_id] = acc[f.campaign_id] || []).push(f);
        return acc;
      }, {});
    }

    const queue = (campaigns || []).map(c => ({ ...c, fraud_flags: flagsByCampaign[c.id] || [] }));
    res.json({ campaigns: queue });
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

async function getNotifications(req, res, next) {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ notifications: data || [] });
  } catch (err) {
    next(err);
  }
}

async function markNotificationRead(req, res, next) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id).select().single();
    if (error) throw error;
    res.json({ notification: data });
  } catch (err) {
    next(err);
  }
}

async function markAllNotificationsRead(req, res, next) {
  try {
    const { error } = await supabase.from('notifications').update({ is_read: true }).eq('is_read', false);
    if (error) throw error;
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    next(err);
  }
}

async function dismissNotification(req, res, next) {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('notifications').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Notification dismissed' });
  } catch (err) {
    next(err);
  }
}

function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

async function getBlogPosts(req, res, next) {
  try {
    const { status } = req.query;
    let query = supabase.from('blog_posts').select('*').order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ posts: data || [] });
  } catch (err) {
    next(err);
  }
}

async function createBlogPost(req, res, next) {
  try {
    const { title, category, excerpt, content, cover_image, author_name, author_role, tags, status, is_featured, read_time } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const baseSlug = slugify(title);
    const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;

    const { data, error } = await supabase
      .from('blog_posts')
      .insert([{
        title, slug, category, excerpt, content, cover_image,
        author_name, author_role, tags: tags || [],
        status: status || 'draft',
        is_featured: !!is_featured,
        read_time: read_time || 5,
        published_at: status === 'published' ? new Date().toISOString() : null,
        created_by: req.user.id,
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ post: data });
  } catch (err) {
    next(err);
  }
}

async function updateBlogPost(req, res, next) {
  try {
    const { id } = req.params;
    const { title, category, excerpt, content, cover_image, author_name, author_role, tags, status, is_featured, read_time } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (category !== undefined) updates.category = category;
    if (excerpt !== undefined) updates.excerpt = excerpt;
    if (content !== undefined) updates.content = content;
    if (cover_image !== undefined) updates.cover_image = cover_image;
    if (author_name !== undefined) updates.author_name = author_name;
    if (author_role !== undefined) updates.author_role = author_role;
    if (tags !== undefined) updates.tags = tags;
    if (is_featured !== undefined) updates.is_featured = is_featured;
    if (read_time !== undefined) updates.read_time = read_time;
    if (status !== undefined) {
      updates.status = status;
      if (status === 'published') updates.published_at = new Date().toISOString();
    }

    const { data, error } = await supabase.from('blog_posts').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json({ post: data });
  } catch (err) {
    next(err);
  }
}

async function deleteBlogPost(req, res, next) {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('blog_posts').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Post deleted' });
  } catch (err) {
    next(err);
  }
}

async function togglePublishBlogPost(req, res, next) {
  try {
    const { id } = req.params;
    const { data: existing, error: fetchError } = await supabase.from('blog_posts').select('status').eq('id', id).single();
    if (fetchError) throw fetchError;

    const newStatus = existing.status === 'published' ? 'draft' : 'published';
    const { data, error } = await supabase
      .from('blog_posts')
      .update({ status: newStatus, published_at: newStatus === 'published' ? new Date().toISOString() : null })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ post: data });
  } catch (err) {
    next(err);
  }
}

async function toggleBlogFeature(req, res, next) {
  try {
    const { id } = req.params;
    const { data: existing, error: fetchError } = await supabase.from('blog_posts').select('is_featured').eq('id', id).single();
    if (fetchError) throw fetchError;

    const { data, error } = await supabase
      .from('blog_posts')
      .update({ is_featured: !existing.is_featured })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ post: data });
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
  flagWithdrawal,
  getReports,
  reviewReport,
  dismissReport,
  getUsers,
  banUser,
  unbanUser,
  getBanAppeals,
  resolveBanAppeal,
  changeUserRole,
  getAllKyc,
  manualApproveKyc,
  getFraudFlags,
  resolveFraudFlag,
  getAuditLogs,
  getLedger,
  getReviewQueue,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  getBlogPosts,
  createBlogPost,
  updateBlogPost,
  deleteBlogPost,
  togglePublishBlogPost,
  toggleBlogFeature,
};

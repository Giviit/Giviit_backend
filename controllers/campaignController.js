const { supabase } = require('../utils/supabaseClient');
const { generateSlug } = require('../services/slugService');
const { v4: uuidv4 } = require('uuid');
const emailService = require('../services/emailService');
const { assessCampaignRisk } = require('../services/fraudDetectionService');
const { notifyAdmins } = require('../services/notificationService');
const { getSettings } = require('../services/settingsService');
const { getRequiredDocs } = require('../services/documentRequirementsService');

// Strips a leading @ and any full profile URL down to a bare handle, so
// facebook.com/foo, @foo, and foo all end up stored as just "foo".
function cleanHandle(handle) {
  if (!handle) return null;
  const stripped = handle.replace(/^https?:\/\/.+\//, '').replace('@', '').trim();
  return stripped ? stripped.slice(0, 50) : null;
}

function withSocialUrls(campaign) {
  return {
    ...campaign,
    facebook_url: campaign.facebook_handle ? `https://facebook.com/${campaign.facebook_handle}` : null,
    instagram_url: campaign.instagram_handle ? `https://instagram.com/${campaign.instagram_handle}` : null,
    twitter_url: campaign.twitter_handle ? `https://twitter.com/${campaign.twitter_handle}` : null,
  };
}

// No deadline → never show "days left"/"ended" anywhere (general rule).
// time_status: 'no_deadline' | 'active' | 'ending_today' | 'ended'
function computeTimeStatus(deadline) {
  if (!deadline) return { time_status: 'no_deadline', days_left: null };
  const now = new Date();
  const end = new Date(deadline);
  const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0) return { time_status: 'ended', days_left: 0 };
  if (daysLeft === 0) return { time_status: 'ending_today', days_left: 0 };
  return { time_status: 'active', days_left: daysLeft };
}
function withTimeStatus(campaign) {
  return { ...campaign, ...computeTimeStatus(campaign.deadline) };
}

async function listCampaigns(req, res, next) {
  try {
    const { category, sort, search, page = 1, limit = 12, my } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let query = supabase.from('campaigns').select('*, creator:profiles(id,full_name,avatar_url)', { count: 'exact' });

    if (my === 'true' && req.user) {
      query = query.eq('creator_id', req.user.id);
    } else {
      query = query.eq('status', 'active');
    }

    if (category) query = query.eq('category', category);
    if (search) query = query.ilike('title', `%${search}%`);

    const orderMap = {
      newest: { column: 'created_at', ascending: false },
      most_funded: { column: 'raised_amount', ascending: false },
      urgent: { column: 'is_urgent', ascending: false },
      ending_soon: { column: 'deadline', ascending: true },
    };
    const orderBy = orderMap[sort] || orderMap.newest;
    query = query.order(orderBy.column, { ascending: orderBy.ascending });
    query = query.range(offset, offset + Number(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      campaigns: (data || []).map(withTimeStatus),
      total: count || 0,
      page: Number(page),
      totalPages: Math.ceil((count || 0) / Number(limit)),
    });
  } catch (err) {
    next(err);
  }
}

async function getFeatured(req, res, next) {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('status', 'active')
      .eq('is_featured', true)
      .order('created_at', { ascending: false })
      .limit(12);
    if (error) throw error;
    res.json({ campaigns: (data || []).map(withTimeStatus) });
  } catch (err) {
    next(err);
  }
}

async function getUrgent(req, res, next) {
  try {
    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('status', 'active')
      .eq('is_urgent', true)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    res.json({ campaigns: (data || []).map(withTimeStatus) });
  } catch (err) {
    next(err);
  }
}

async function getCampaignBySlug(req, res, next) {
  try {
    const { slug } = req.params;
    const { data, error } = await supabase
      .from('campaigns')
      .select('*, creator:profiles(id,full_name,avatar_url,bvn_verified)')
      .eq('slug', slug)
      .single();
    if (error) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: withSocialUrls(withTimeStatus(data)) });
  } catch (err) {
    next(err);
  }
}

async function createCampaign(req, res, next) {
  try {
    const {
      title, description, story, cover_image, gallery, category, goal_amount, deadline, is_urgent, date_of_birth,
      facebook_handle, instagram_handle, twitter_handle,
      creator_country, creator_state, creator_city,
    } = req.body;
    const creator_id = req.user.id;

    // Returning creators don't have to re-type their location/socials —
    // silently pull whichever of these fields weren't sent from their most
    // recent previous campaign.
    let location = { creator_country: creator_country || null, creator_state: creator_state || null, creator_city: creator_city || null };
    let socials = { facebook_handle, instagram_handle, twitter_handle };
    if (!location.creator_country && !location.creator_state && !socials.facebook_handle && !socials.instagram_handle && !socials.twitter_handle) {
      const { data: lastCampaign } = await supabase
        .from('campaigns')
        .select('creator_country, creator_state, creator_city, facebook_handle, instagram_handle, twitter_handle')
        .eq('creator_id', creator_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastCampaign) {
        location = {
          creator_country: location.creator_country || lastCampaign.creator_country,
          creator_state: location.creator_state || lastCampaign.creator_state,
          creator_city: location.creator_city || lastCampaign.creator_city,
        };
        socials = {
          facebook_handle: socials.facebook_handle || lastCampaign.facebook_handle,
          instagram_handle: socials.instagram_handle || lastCampaign.instagram_handle,
          twitter_handle: socials.twitter_handle || lastCampaign.twitter_handle,
        };
      }
    }

    if (Boolean(is_urgent) && !deadline) {
      return res.status(400).json({ error: 'Urgent campaigns must have a deadline date and time' });
    }

    // Age check — must be 18+
    if (date_of_birth) {
      const dob = new Date(date_of_birth);
      const today = new Date();
      const age = today.getFullYear() - dob.getFullYear() - (
        today < new Date(today.getFullYear(), dob.getMonth(), dob.getDate()) ? 1 : 0
      );
      if (age < 18) {
        return res.status(403).json({ error: 'You must be at least 18 years old to create a campaign' });
      }
    }

    const settings = await getSettings();
    if (Number(goal_amount) > Number(settings.maxCampaignGoal)) {
      return res.status(400).json({ error: `Campaign goals are capped at ₦${Number(settings.maxCampaignGoal).toLocaleString()}. For larger goals, please contact support@giviit.ng.` });
    }

    const slug = generateSlug(title);
    const candidate = {
      title, description, story, cover_image,
      goal_amount: Number(goal_amount), is_urgent: Boolean(is_urgent),
    };

    // Pattern-recognition / fraud risk check — campaigns that don't trip any
    // rule go straight live; flagged ones are held for manual admin approval.
    const { data: creator } = await supabase
      .from('profiles')
      .select('id, created_at, verification_status, bank_account_number')
      .eq('id', creator_id)
      .single();

    const { score, reasons, requiresReview } = await assessCampaignRisk({ campaign: candidate, creator });

    // Categories with required verification documents go to 'draft' instead
    // of live/review — they only become visible once the creator has
    // uploaded the required docs and called POST /campaigns/:id/publish,
    // which re-runs this same fraud check at that point.
    const requiredDocs = getRequiredDocs(category);
    const initialStatus = requiredDocs.length > 0 ? 'draft' : (requiresReview ? 'pending' : 'active');

    const { data, error } = await supabase
      .from('campaigns')
      .insert([{
        creator_id,
        title,
        slug,
        description,
        story,
        cover_image,
        gallery: gallery || [],
        category,
        goal_amount: Number(goal_amount),
        deadline: deadline || null,
        is_urgent: Boolean(is_urgent),
        allow_overfunding: false,
        facebook_handle: cleanHandle(socials.facebook_handle),
        instagram_handle: cleanHandle(socials.instagram_handle),
        twitter_handle: cleanHandle(socials.twitter_handle),
        creator_country: location.creator_country || 'NG',
        creator_state: location.creator_state || null,
        creator_city: location.creator_city || null,
        status: initialStatus,
        fraud_risk_score: score,
        raised_amount: 0,
        donor_count: 0,
      }])
      .select()
      .single();

    if (error) throw error;

    if (initialStatus === 'draft') {
      // Held back from review/notifications until publish — nothing else to do yet.
    } else if (requiresReview) {
      if (reasons.length) {
        await supabase.from('fraud_flags').insert(
          reasons.map(r => ({ campaign_id: data.id, flag_type: r.flag_type, details: r.details, risk_score: score }))
        );
      }
      if (settings.emailOnFraudFlag) {
        await notifyAdmins({
          type: 'fraud_flag',
          title: 'Campaign held for manual review',
          message: `"${data.title}" was held for review (risk score ${score}) — ${reasons[0]?.details || 'multiple risk signals detected'}`,
          link: '/review-queue',
          campaignId: data.id,
        });
      }
      try {
        await emailService.campaignFlaggedForReview(req.user.email, { campaign_title: data.title });
      } catch {}
    } else if (settings.emailOnNewCampaign) {
      await notifyAdmins({
        type: 'campaign_created',
        title: 'New campaign published',
        message: `"${data.title}" went live automatically. Review it whenever convenient.`,
        link: '/campaigns',
        campaignId: data.id,
      });
    }

    res.status(201).json({ campaign: withSocialUrls(withTimeStatus(data)), required_documents: requiredDocs });
  } catch (err) {
    next(err);
  }
}

// Flips a 'draft' campaign (one whose category required verification
// documents) live, after checking those documents are actually attached.
// Re-runs the same fraud check createCampaign would have run, since the
// campaign's content may have changed since it was first saved as a draft.
async function publishCampaign(req, res, next) {
  try {
    const { id } = req.params;
    const { data: campaign, error: getError } = await supabase
      .from('campaigns').select('*').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (campaign.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft campaigns can be published' });
    }

    const requiredDocs = getRequiredDocs(campaign.category);
    const { data: uploaded } = await supabase
      .from('campaign_documents').select('document_type').eq('campaign_id', id);
    const uploadedTypes = (uploaded || []).map(d => d.document_type);
    const missing = requiredDocs.filter(d => !uploadedTypes.includes(d));

    if (missing.length > 0) {
      return res.status(400).json({
        error: 'Please upload required documents before publishing',
        missing_documents: missing,
        code: 'MISSING_DOCUMENTS',
      });
    }

    // KYC gate — a returning creator verified within the last year skips
    // straight through (requires_kyc: false) instead of being shown the
    // verification step again; a first-timer or anyone whose verification
    // has lapsed past a year is told so, silently, with no separate loading
    // state — the frontend just branches on requires_kyc.
    const { data: kyc } = await supabase
      .from('kyc_verifications')
      .select('status, verified_at')
      .eq('user_id', req.user.id)
      .eq('status', 'verified')
      .order('verified_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    const kycExpired = kyc?.verified_at && (Date.now() - new Date(kyc.verified_at).getTime()) > ONE_YEAR_MS;

    if (!kyc) {
      return res.json({
        status: 'kyc_required',
        requires_kyc: true,
        reason: 'first_time',
        message: 'Please verify your identity to publish your campaign.',
      });
    }
    if (kycExpired) {
      return res.json({
        status: 'kyc_required',
        requires_kyc: true,
        reason: 'annual_reverification',
        message: 'Your annual re-verification is due. Please verify your identity again to publish.',
      });
    }

    const settings = await getSettings();
    const { data: creator } = await supabase
      .from('profiles').select('id, created_at, verification_status, bank_account_number').eq('id', campaign.creator_id).single();
    const { score, reasons, requiresReview } = await assessCampaignRisk({ campaign, creator });

    const finalStatus = requiresReview ? 'pending' : 'active';
    const { data: published, error } = await supabase
      .from('campaigns')
      .update({ status: finalStatus, fraud_risk_score: score, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    if (requiresReview) {
      if (reasons.length) {
        await supabase.from('fraud_flags').insert(
          reasons.map(r => ({ campaign_id: id, flag_type: r.flag_type, details: r.details, risk_score: score }))
        );
      }
      if (settings.emailOnFraudFlag) {
        await notifyAdmins({
          type: 'fraud_flag',
          title: 'Campaign held for manual review',
          message: `"${campaign.title}" was held for review (risk score ${score}) — ${reasons[0]?.details || 'multiple risk signals detected'}`,
          link: '/review-queue',
          campaignId: id,
        });
      }
      try {
        await emailService.campaignFlaggedForReview(req.user.email, { campaign_title: campaign.title });
      } catch {}
    } else if (settings.emailOnNewCampaign) {
      await notifyAdmins({
        type: 'campaign_created',
        title: 'New campaign published',
        message: `"${campaign.title}" went live automatically. Review it whenever convenient.`,
        link: '/campaigns',
        campaignId: id,
      });
    }

    res.json({ campaign: withSocialUrls(withTimeStatus(published)), requires_kyc: false });
  } catch (err) {
    next(err);
  }
}

async function updateCampaign(req, res, next) {
  try {
    const { id } = req.params;
    const { data: campaign, error: getError } = await supabase
      .from('campaigns').select('creator_id, is_urgent, deadline').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const allowed = [
      'title', 'description', 'story', 'cover_image', 'gallery', 'category', 'goal_amount', 'deadline', 'is_urgent',
      'facebook_handle', 'instagram_handle', 'twitter_handle',
      'creator_country', 'creator_state', 'creator_city',
    ];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    ['facebook_handle', 'instagram_handle', 'twitter_handle'].forEach(k => {
      if (updates[k] !== undefined) updates[k] = cleanHandle(updates[k]);
    });
    updates.updated_at = new Date().toISOString();

    const finalIsUrgent = updates.is_urgent !== undefined ? Boolean(updates.is_urgent) : campaign.is_urgent;
    const finalDeadline = updates.deadline !== undefined ? updates.deadline : campaign.deadline;
    if (finalIsUrgent && !finalDeadline) {
      return res.status(400).json({ error: 'Urgent campaigns must have a deadline date and time' });
    }

    if (updates.goal_amount !== undefined) {
      const { maxCampaignGoal } = await getSettings();
      if (Number(updates.goal_amount) > Number(maxCampaignGoal)) {
        return res.status(400).json({ error: `Campaign goals are capped at ₦${Number(maxCampaignGoal).toLocaleString()}. For larger goals, please contact support@giviit.ng.` });
      }
    }

    const { data, error } = await supabase.from('campaigns').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json({ campaign: withSocialUrls(withTimeStatus(data)) });
  } catch (err) {
    next(err);
  }
}

// Creator-initiated manual close — used when overfunding is allowed and the
// creator decides they have enough, or any time they want to stop accepting
// donations early. Distinct from the goal-reached auto-close (overfundingService)
// and the deadline-expiry auto-close (campaignExpiryService).
async function closeCampaign(req, res, next) {
  try {
    const { id } = req.params;
    const { data: campaign, error: getError } = await supabase
      .from('campaigns').select('creator_id, title, raised_amount, status').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (campaign.status === 'completed') return res.status(400).json({ error: 'Campaign is already closed' });

    const { data, error } = await supabase
      .from('campaigns')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    try {
      await emailService.campaignClosed(req.user.email, { campaign_title: campaign.title, raised_amount: campaign.raised_amount });
    } catch {}

    const { data: donations } = await supabase
      .from('donations')
      .select('donor_email, donor_name')
      .eq('campaign_id', id)
      .eq('paystack_status', 'success');

    const seen = new Set();
    for (const d of donations || []) {
      if (!d.donor_email || seen.has(d.donor_email)) continue;
      seen.add(d.donor_email);
      try {
        await emailService.sendEmail({
          to: d.donor_email,
          subject: `Thank you — ${campaign.title} has closed`,
          html: `<p>Hi ${d.donor_name || 'there'}, the campaign "${campaign.title}" you supported has officially closed. Thank you for making a difference!</p>`,
        });
      } catch {}
    }

    res.json({ campaign: withTimeStatus(data) });
  } catch (err) {
    next(err);
  }
}

async function deleteCampaign(req, res, next) {
  try {
    const { id } = req.params;
    const { data: campaign, error: getError } = await supabase
      .from('campaigns').select('creator_id').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { error } = await supabase.from('campaigns').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'Campaign deleted' });
  } catch (err) {
    next(err);
  }
}

async function postUpdate(req, res, next) {
  try {
    const campaignId = req.params.id;
    const { title, content, image_url } = req.body;

    const { data: campaign, error: getError } = await supabase
      .from('campaigns').select('creator_id').eq('id', campaignId).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { data, error } = await supabase
      .from('campaign_updates')
      .insert([{ campaign_id: campaignId, title, content, image_url: image_url || null }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ update: data });
  } catch (err) {
    next(err);
  }
}

async function getCampaignUpdates(req, res, next) {
  try {
    const campaignId = req.params.id;
    const { data, error } = await supabase
      .from('campaign_updates')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ updates: data || [] });
  } catch (err) {
    next(err);
  }
}

async function reportCampaign(req, res, next) {
  try {
    const campaignId = req.params.id;
    const { reporter_email, reason, details, email } = req.body;
    const { data, error } = await supabase
      .from('reports')
      .insert([{
        campaign_id: campaignId,
        reporter_email: reporter_email || email,
        reason,
        details,
        status: 'pending',
      }])
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ report: data });
  } catch (err) {
    next(err);
  }
}

async function inviteCoOwner(req, res, next) {
  try {
    const { id } = req.params;
    const { email } = req.body;

    const { data: campaign, error: getError } = await supabase.from('campaigns').select('creator_id').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const token = uuidv4();
    const { error } = await supabase
      .from('campaign_members')
      .insert({ campaign_id: id, invited_email: email, role: 'co-owner', status: 'pending', invite_token: token });
    if (error) throw error;
    const acceptUrl = `${process.env.FRONTEND_URL}/campaigns/accept-invite/${token}`;
    await emailService.sendEmail({
      to: email,
      subject: "You've been invited to co-manage a campaign on Giviit",
      html: `<p>You have been invited to co-manage a campaign. <a href="${acceptUrl}">Accept Invitation</a></p>`,
    });
    res.json({ message: 'Invitation sent' });
  } catch (err) {
    next(err);
  }
}

async function removeCoOwner(req, res, next) {
  try {
    const { id, userId } = req.params;

    const { data: campaign, error: getError } = await supabase.from('campaigns').select('creator_id').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    await supabase.from('campaign_members').delete().eq('campaign_id', id).eq('user_id', userId);
    res.json({ message: 'Removed' });
  } catch (err) {
    next(err);
  }
}

async function saveMilestones(req, res, next) {
  try {
    const { id } = req.params;
    const { milestones } = req.body;

    const { data: campaign, error: getError } = await supabase.from('campaigns').select('creator_id, goal_amount').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    if (milestones?.some(m => Number(m.amount) > Number(campaign.goal_amount))) {
      return res.status(400).json({ error: 'A milestone amount cannot exceed the overall campaign goal.' });
    }

    await supabase.from('campaign_milestones').delete().eq('campaign_id', id);
    if (milestones?.length) {
      const rows = milestones.map((m, i) => ({ ...m, campaign_id: id, order_index: i }));
      await supabase.from('campaign_milestones').insert(rows);
    }
    res.json({ message: 'Milestones saved' });
  } catch (err) {
    next(err);
  }
}

async function addGuarantor(req, res, next) {
  try {
    const { id } = req.params;
    const { guarantor_name, guarantor_email, guarantor_phone, guarantor_relationship } = req.body;

    const { data: campaign, error: getError } = await supabase.from('campaigns').select('creator_id').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const token = uuidv4();
    await supabase
      .from('campaigns')
      .update({ guarantor_name, guarantor_email, guarantor_phone, guarantor_relationship, guarantor_token: token, guarantor_status: 'pending' })
      .eq('id', id);
    const vouchUrl = `${process.env.FRONTEND_URL}/vouch/${token}`;
    await emailService.sendEmail({
      to: guarantor_email,
      subject: "You've been asked to vouch for a campaign on Giviit",
      html: `<p>${guarantor_name}, someone has nominated you as a guarantor for their fundraising campaign. <a href="${vouchUrl}">Click here to vouch or decline</a>.</p>`,
    });
    res.json({ message: 'Guarantor invited' });
  } catch (err) {
    next(err);
  }
}

async function handleVouchGet(req, res, next) {
  try {
    const { token } = req.params;
    const { data, error } = await supabase
      .from('campaigns')
      .select('id,title,description,cover_image,guarantor_name')
      .eq('guarantor_token', token)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Invalid token' });
    res.json({ campaign: data });
  } catch (err) {
    next(err);
  }
}

async function handleVouch(req, res, next) {
  try {
    const { token } = req.params;
    const { message } = req.body;
    const { error } = await supabase
      .from('campaigns')
      .update({ guarantor_status: 'vouched', guarantor_message: message })
      .eq('guarantor_token', token);
    if (error) throw error;
    res.json({ message: 'Vouched successfully' });
  } catch (err) {
    next(err);
  }
}

async function handleDeclineVouch(req, res, next) {
  try {
    const { token } = req.params;
    await supabase.from('campaigns').update({ guarantor_status: 'declined' }).eq('guarantor_token', token);
    res.json({ message: 'Declined' });
  } catch (err) {
    next(err);
  }
}

async function submitAppeal(req, res, next) {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message || message.trim().length < 20) {
      return res.status(400).json({ error: 'Appeal message must be at least 20 characters' });
    }

    const { data: campaign, error: getError } = await supabase
      .from('campaigns')
      .select('creator_id, title, status, appeal_status')
      .eq('id', id)
      .single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    if (!['pending', 'rejected'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Only campaigns held for review or rejected can be appealed' });
    }
    if (campaign.appeal_status === 'pending') {
      return res.status(400).json({ error: 'An appeal is already under review for this campaign' });
    }

    await supabase.from('campaigns').update({
      appeal_message: message,
      appeal_status: 'pending',
      appeal_submitted_at: new Date().toISOString(),
    }).eq('id', id);

    await notifyAdmins({
      type: 'appeal',
      title: 'Campaign appeal submitted',
      message: `Creator appealed the hold on "${campaign.title}"`,
      link: '/review-queue',
      campaignId: id,
    });

    try {
      await emailService.sendEmail({
        to: req.user.email,
        subject: `Appeal received — ${campaign.title}`,
        html: `<p>We've received your appeal for "${campaign.title}". Our team will review it within 24–48 hours.</p>`,
      });
    } catch {}

    res.json({ message: 'Appeal submitted' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listCampaigns,
  getFeatured,
  getUrgent,
  getCampaignBySlug,
  createCampaign,
  publishCampaign,
  updateCampaign,
  closeCampaign,
  deleteCampaign,
  postUpdate,
  getCampaignUpdates,
  reportCampaign,
  inviteCoOwner,
  removeCoOwner,
  saveMilestones,
  addGuarantor,
  handleVouchGet,
  handleVouch,
  handleDeclineVouch,
  submitAppeal,
};

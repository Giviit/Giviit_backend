const { supabase } = require('../utils/supabaseClient');
const { generateSlug } = require('../services/slugService');
const { v4: uuidv4 } = require('uuid');
const emailService = require('../services/emailService');
const { assessCampaignRisk } = require('../services/fraudDetectionService');
const { notifyAdmins } = require('../services/notificationService');
const { getSettings } = require('../services/settingsService');

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
      campaigns: data || [],
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
    res.json({ campaigns: data || [] });
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
    res.json({ campaigns: data || [] });
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
    res.json({ campaign: data });
  } catch (err) {
    next(err);
  }
}

async function createCampaign(req, res, next) {
  try {
    const { title, description, story, cover_image, gallery, category, goal_amount, deadline, is_urgent, date_of_birth } = req.body;
    const creator_id = req.user.id;

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
        status: requiresReview ? 'pending' : 'active',
        fraud_risk_score: score,
        raised_amount: 0,
        donor_count: 0,
      }])
      .select()
      .single();

    if (error) throw error;

    if (requiresReview) {
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

    res.status(201).json({ campaign: data });
  } catch (err) {
    next(err);
  }
}

async function updateCampaign(req, res, next) {
  try {
    const { id } = req.params;
    const { data: campaign, error: getError } = await supabase
      .from('campaigns').select('creator_id').eq('id', id).single();
    if (getError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const allowed = ['title', 'description', 'story', 'cover_image', 'gallery', 'category', 'goal_amount', 'deadline', 'is_urgent'];
    const updates = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    updates.updated_at = new Date().toISOString();

    if (updates.goal_amount !== undefined) {
      const { maxCampaignGoal } = await getSettings();
      if (Number(updates.goal_amount) > Number(maxCampaignGoal)) {
        return res.status(400).json({ error: `Campaign goals are capped at ₦${Number(maxCampaignGoal).toLocaleString()}. For larger goals, please contact support@giviit.ng.` });
      }
    }

    const { data, error } = await supabase.from('campaigns').update(updates).eq('id', id).select().single();
    if (error) throw error;
    res.json({ campaign: data });
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
  updateCampaign,
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

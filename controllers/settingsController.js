const { getSettings, updateSettings } = require('../services/settingsService');
const { logAudit } = require('../utils/auditLog');

// Unauthenticated — only the flags other parts of the app need to gate
// public behaviour (registration form, maintenance banner, etc.)
async function getPublicSettings(req, res, next) {
  try {
    const s = await getSettings();
    res.json({
      allowNewRegistrations: s.allowNewRegistrations,
      maintenanceMode: s.maintenanceMode,
      enablePledgeFeature: s.enablePledgeFeature,
      enableOfflineDonations: s.enableOfflineDonations,
      maxCampaignGoal: s.maxCampaignGoal,
      minWithdrawalAmount: s.minWithdrawalAmount,
    });
  } catch (err) {
    next(err);
  }
}

async function getAdminSettings(req, res, next) {
  try {
    res.json({ settings: await getSettings() });
  } catch (err) {
    next(err);
  }
}

async function updateAdminSettings(req, res, next) {
  try {
    const settings = await updateSettings(req.body, req.user.id);
    await logAudit({ action: 'SETTINGS_UPDATED', entityType: 'platform_settings', entityId: null, performedBy: req.user.id, metadata: req.body });
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

module.exports = { getPublicSettings, getAdminSettings, updateAdminSettings };

const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const { blockBanned } = require('../middleware/blockBanned');
const {
  listCampaigns,
  getFeatured,
  getUrgent,
  getCampaignBySlug,
  createCampaign,
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
  publishCampaign,
} = require('../controllers/campaignController');
const {
  uploadCampaignDocument,
  getCampaignDocumentsOwner,
  deleteCampaignDocument,
} = require('../controllers/documentController');

// Static routes first
router.get('/featured', getFeatured);
router.get('/urgent', getUrgent);

// Authenticated optional (for my=true filter)
router.get('/', (req, res, next) => {
  if (req.query.my === 'true') return authenticateUser(req, res, next);
  next();
}, listCampaigns);

router.post('/', authenticateUser, blockBanned, createCampaign);

// Slug route — must come after named routes
router.get('/:slug', getCampaignBySlug);
router.put('/:id', authenticateUser, blockBanned, updateCampaign);
router.put('/:id/close', authenticateUser, closeCampaign);
router.delete('/:id', authenticateUser, deleteCampaign);
router.get('/:id/updates', getCampaignUpdates);
router.post('/:id/update', authenticateUser, postUpdate);
router.post('/:id/report', reportCampaign);

// Group campaigns / co-owner management
router.post('/:id/invite', authenticateUser, inviteCoOwner);
router.delete('/:id/members/:userId', authenticateUser, removeCoOwner);

// Milestones
router.post('/:id/milestones', authenticateUser, saveMilestones);

// Guarantor / vouch
router.post('/:id/guarantor', authenticateUser, addGuarantor);
router.get('/vouch/:token', handleVouchGet);
router.post('/vouch/:token', handleVouch);
router.post('/decline-vouch/:token', handleDeclineVouch);

// Appeal
router.post('/:id/appeal', authenticateUser, submitAppeal);

// Publish (flips a 'draft' campaign live once required documents are attached)
router.post('/:id/publish', authenticateUser, blockBanned, publishCampaign);

// Verification documents (owner-only; admin reads via adminRoutes.js)
router.post('/:id/documents', authenticateUser, uploadCampaignDocument);
router.get('/:id/documents', authenticateUser, getCampaignDocumentsOwner);
router.delete('/:id/documents/:doc_id', authenticateUser, deleteCampaignDocument);

module.exports = router;

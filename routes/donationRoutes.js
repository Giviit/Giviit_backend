const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const {
  initiateDonation,
  verifyDonation,
  getCampaignDonations,
  logOfflineDonation,
  deleteOfflineDonation,
  getOfflineDonations,
  getDiasporaDonors,
} = require('../controllers/donationController');

router.post('/initiate', initiateDonation);
router.get('/verify/:reference', verifyDonation);
router.get('/campaign/:campaign_id', getCampaignDonations);

// Offline donations
router.post('/offline', authenticateUser, logOfflineDonation);
router.delete('/offline/:id', authenticateUser, deleteOfflineDonation);
router.get('/offline/:campaign_id', authenticateUser, getOfflineDonations);

// Diaspora donors
router.get('/campaign/:id/diaspora', getDiasporaDonors);

module.exports = router;

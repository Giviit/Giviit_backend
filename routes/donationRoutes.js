const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const {
  initiateDonation,
  verifyDonation,
  getDonationStatus,
  getCampaignDonations,
  getMyDonations,
  logOfflineDonation,
  deleteOfflineDonation,
  getOfflineDonations,
  getDiasporaDonors,
} = require('../controllers/donationController');

// Donors poll this with no auth while waiting on a bank transfer/USSD payment
// to clear — needs a much looser cap than the hourly donation-initiate limiter.
const statusLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

router.post('/initiate', initiateDonation);
router.get('/verify/:reference', verifyDonation);
router.get('/status/:reference', statusLimiter, getDonationStatus);
router.get('/my', authenticateUser, getMyDonations);
router.get('/campaign/:campaign_id', getCampaignDonations);

// Offline donations
router.post('/offline', authenticateUser, logOfflineDonation);
router.delete('/offline/:id', authenticateUser, deleteOfflineDonation);
router.get('/offline/:campaign_id', authenticateUser, getOfflineDonations);

// Diaspora donors
router.get('/campaign/:id/diaspora', getDiasporaDonors);

module.exports = router;

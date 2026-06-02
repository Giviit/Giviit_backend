const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const kyc = require('../controllers/kycController');

router.post('/initiate', authenticateUser, kyc.initiateKyc);
router.get('/status', authenticateUser, kyc.getKycStatus);
router.post('/webhook', kyc.handleShuftiWebhook);

module.exports = router;

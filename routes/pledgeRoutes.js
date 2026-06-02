const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const { createPledge, getCampaignPledges, payNextInstallment } = require('../controllers/pledgeController');

router.post('/', createPledge);
router.get('/campaign/:campaign_id', getCampaignPledges);
router.post('/:id/pay', payNextInstallment);

module.exports = router;

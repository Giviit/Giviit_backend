const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const { requestWithdrawal, getMyWithdrawals, getCampaignBalance } = require('../controllers/withdrawalController');

router.post('/', authenticateUser, requestWithdrawal);
router.get('/my', authenticateUser, getMyWithdrawals);
router.get('/balance/:campaign_id', authenticateUser, getCampaignBalance);

module.exports = router;

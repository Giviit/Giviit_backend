const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const { blockBanned } = require('../middleware/blockBanned');
const { requestWithdrawal, getMyWithdrawals, getCampaignBalance } = require('../controllers/withdrawalController');

router.post('/', authenticateUser, blockBanned, requestWithdrawal);
router.get('/my', authenticateUser, getMyWithdrawals);
router.get('/balance/:campaign_id', authenticateUser, getCampaignBalance);

module.exports = router;

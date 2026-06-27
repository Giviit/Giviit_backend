const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const { blockBanned } = require('../middleware/blockBanned');
const { requestWithdrawal, getMyWithdrawals, getCampaignBalance, resolveAccount } = require('../controllers/withdrawalController');

// Fires on every keystroke combination that completes a valid account
// number + bank pair, so it needs its own (generous but bounded) limiter
// rather than sharing the global per-IP one.
const resolveAccountLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || req.ip,
});

router.post('/', authenticateUser, blockBanned, requestWithdrawal);
router.get('/my', authenticateUser, getMyWithdrawals);
router.get('/balance/:campaign_id', authenticateUser, getCampaignBalance);
router.get('/resolve-account', authenticateUser, resolveAccountLimiter, resolveAccount);

module.exports = router;

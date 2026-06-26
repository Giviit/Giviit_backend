const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const { getAnalytics } = require('../controllers/dashboardController');

router.get('/analytics', authenticateUser, getAnalytics);

module.exports = router;

const express = require('express');
const router = express.Router();
const { handlePaystackWebhook } = require('../controllers/webhookController');

router.post('/', express.raw({ type: 'application/json' }), handlePaystackWebhook);

module.exports = router;

const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const { uploadImageHandler } = require('../controllers/uploadController');

router.post('/image', authenticateUser, uploadImageHandler);

module.exports = router;

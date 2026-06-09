const express = require('express');
const router = express.Router();
const { register, login, logout, forgotPassword, resetPassword, googleSync, me, updateProfile } = require('../controllers/authController');
const { authenticateUser } = require('../middleware/authenticateUser');

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.post('/forgot-password', forgotPassword);
router.post('/google/sync', googleSync);
router.post('/reset-password', resetPassword);
router.get('/me', authenticateUser, me);
router.put('/profile', authenticateUser, updateProfile);

module.exports = router;

const express = require('express');
const router = express.Router();
const { register, login, logout, forgotPassword, resetPassword, refreshToken, resendVerification, googleRedirect, googleBridge, googleSync, me, updateProfile, verifyIdentity, submitBanAppeal } = require('../controllers/authController');
const { authenticateUser } = require('../middleware/authenticateUser');

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.post('/refresh', refreshToken);
router.post('/resend-verification', resendVerification);
router.post('/forgot-password', forgotPassword);
router.get('/google', googleRedirect);
router.get('/google/bridge', googleBridge);
router.post('/google/sync', googleSync);
router.post('/reset-password', resetPassword);
router.get('/me', authenticateUser, me);
router.put('/profile', authenticateUser, updateProfile);
router.post('/verify-identity', authenticateUser, verifyIdentity);
router.post('/appeal-ban', authenticateUser, submitBanAppeal);

module.exports = router;

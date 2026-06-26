const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const { requireAdmin } = require('../middleware/requireAdmin');
const admin = require('../controllers/adminController');
const { getAdminSettings, updateAdminSettings } = require('../controllers/settingsController');

router.use(authenticateUser, requireAdmin);

// Platform settings
router.get('/settings', getAdminSettings);
router.put('/settings', updateAdminSettings);

// Dashboard
router.get('/dashboard', admin.dashboardStats);

// Campaigns
router.get('/campaigns', admin.getAllCampaigns);
router.put('/campaigns/:id/verify', admin.verifyCampaign);
router.put('/campaigns/:id/reject', admin.rejectCampaign);
router.put('/campaigns/:id/freeze', admin.freezeCampaign);
router.put('/campaigns/:id/fraudulent', admin.markFraudulent);
router.put('/campaigns/:id/feature', admin.toggleFeature);
router.put('/campaigns/:id/urgent', admin.toggleUrgent);

// Withdrawals
router.get('/withdrawals', admin.getWithdrawals);
router.put('/withdrawals/:id/approve', admin.approveWithdrawal);
router.put('/withdrawals/:id/reject', admin.rejectWithdrawal);

// Reports
router.get('/reports', admin.getReports);
router.put('/reports/:id/review', admin.reviewReport);
router.put('/reports/:id/dismiss', admin.dismissReport);

// Users
router.get('/users', admin.getUsers);
router.put('/users/:id/ban', admin.banUser);
router.put('/users/:id/unban', admin.unbanUser);
router.put('/users/:id/role', admin.changeUserRole);
router.get('/ban-appeals', admin.getBanAppeals);
router.put('/ban-appeals/:id', admin.resolveBanAppeal);

// KYC
router.get('/kyc', admin.getAllKyc);
router.put('/kyc/:id/approve', admin.manualApproveKyc);

// Fraud flags
router.get('/fraud-flags', admin.getFraudFlags);
router.put('/fraud-flags/:id/resolve', admin.resolveFraudFlag);

// Review queue (campaigns held by fraud detection, awaiting manual approval)
router.get('/review-queue', admin.getReviewQueue);

// Notifications
router.get('/notifications', admin.getNotifications);
router.put('/notifications/:id/read', admin.markNotificationRead);
router.put('/notifications/read-all', admin.markAllNotificationsRead);
router.delete('/notifications/:id', admin.dismissNotification);

// Audit & Ledger
router.get('/audit-logs', admin.getAuditLogs);
router.get('/ledger', admin.getLedger);

// Blog
router.get('/blog', admin.getBlogPosts);
router.post('/blog', admin.createBlogPost);
router.put('/blog/:id', admin.updateBlogPost);
router.delete('/blog/:id', admin.deleteBlogPost);
router.put('/blog/:id/publish', admin.togglePublishBlogPost);
router.put('/blog/:id/feature', admin.toggleBlogFeature);

module.exports = router;

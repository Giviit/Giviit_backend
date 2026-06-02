const express = require('express');
const router = express.Router();
const { authenticateUser } = require('../middleware/authenticateUser');
const { requireAdmin } = require('../middleware/requireAdmin');
const admin = require('../controllers/adminController');

router.use(authenticateUser, requireAdmin);

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

// KYC
router.get('/kyc', admin.getAllKyc);
router.put('/kyc/:id/approve', admin.manualApproveKyc);

// Fraud flags
router.get('/fraud-flags', admin.getFraudFlags);
router.put('/fraud-flags/:id/resolve', admin.resolveFraudFlag);

// Audit & Ledger
router.get('/audit-logs', admin.getAuditLogs);
router.get('/ledger', admin.getLedger);

module.exports = router;

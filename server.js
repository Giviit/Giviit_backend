const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/authRoutes');
const campaignRoutes = require('./routes/campaignRoutes');
const donationRoutes = require('./routes/donationRoutes');
const withdrawalRoutes = require('./routes/withdrawalRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const adminRoutes = require('./routes/adminRoutes');
const pledgeRoutes = require('./routes/pledgeRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const kycRoutes = require('./routes/kycRoutes');
const { errorHandler } = require('./middleware/errorHandler');

dotenv.config();

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));

// Raw body must be captured BEFORE json parser for webhook signature verification
app.use('/api/webhooks', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '15mb' }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 100 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const donationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });

app.use('/api/', limiter);
app.use('/api/auth', authLimiter);
app.use('/api/donations', donationLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/donations', donationRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/pledges', pledgeRoutes);
app.use('/api/webhooks/paystack', webhookRoutes);
app.use('/api/kyc', kycRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Givia backend running on port ${PORT}`));

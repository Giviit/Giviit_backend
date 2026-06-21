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
const { getCampaignShareHTML } = require('./controllers/shareController');
const { errorHandler } = require('./middleware/errorHandler');

dotenv.config();

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  process.env.ADMIN_URL   || 'http://localhost:5174',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server requests (no origin) and listed origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
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

// Server-rendered preview page so link unfurlers (WhatsApp, Facebook, Telegram, etc.)
// see the campaign's actual cover image — they don't execute the SPA's client-side JS.
app.get('/share/campaign/:slug', getCampaignShareHTML);

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Giviit backend running on port ${PORT}`));

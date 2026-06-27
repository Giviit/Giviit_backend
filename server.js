const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const cron = require('node-cron');
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
const dashboardRoutes = require('./routes/dashboardRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const { getCampaignShareHTML } = require('./controllers/shareController');
const { getStatusJSON, getStatusPage } = require('./controllers/statusController');
const { errorHandler } = require('./middleware/errorHandler');
const { getSettings } = require('./services/settingsService');
const { sendDuePledgeReminders } = require('./services/pledgeReminderService');
const { closeExpiredCampaigns } = require('./services/campaignExpiryService');
const { expireStalePayments } = require('./services/paymentExpiryService');

dotenv.config();

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5173',
  process.env.ADMIN_URL   || 'http://localhost:5174',
  'https://giviit-web.vercel.app',
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
// The donor-facing status-polling route has its own much looser limiter
// (donationRoutes.js) — it must not also be throttled by the 20/hour
// donation-initiate limiter below, since a single bank-transfer donation
// polls this every few seconds for up to 30 minutes.
app.use('/api/donations', (req, res, next) => {
  if (req.path.startsWith('/status/')) return next();
  return donationLimiter(req, res, next);
});

// Maintenance mode (toggled from Admin → Settings) blocks everything except
// the admin panel itself, the public settings check, status/health checks,
// and the Paystack webhook (so in-flight payments still get reconciled).
// Paths here are relative to the '/api' mount point below (Express strips
// the mount prefix from req.path for middleware mounted on a sub-path).
const MAINTENANCE_EXEMPT_PREFIXES = ['/admin', '/settings', '/status', '/webhooks'];
app.use('/api', async (req, res, next) => {
  if (MAINTENANCE_EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  try {
    const settings = await getSettings();
    if (settings.maintenanceMode) {
      return res.status(503).json({ error: 'Giviit is currently undergoing maintenance. Please check back shortly.', code: 'MAINTENANCE_MODE' });
    }
  } catch {
    // Settings table missing/unreachable — fail open rather than taking the whole API down.
  }
  next();
});

app.use('/api/settings', settingsRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/donations', donationRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/pledges', pledgeRoutes);
app.use('/api/webhooks/paystack', webhookRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Status check — actually probes Supabase (and reports config presence for the
// other integrations) instead of just confirming the process is alive.
app.get('/status', getStatusPage);
app.get('/api/status', getStatusJSON);

// Server-rendered preview page so link unfurlers (WhatsApp, Facebook, Telegram, etc.)
// see the campaign's actual cover image — they don't execute the SPA's client-side JS.
app.get('/share/campaign/:slug', getCampaignShareHTML);

app.use(errorHandler);

// Pledge installment reminders — runs once at boot (in case the process was
// down when a reminder was due) then once every 24h. No job queue in this
// app, so a plain interval is the simplest thing that's actually reliable
// for a single long-running backend process.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
sendDuePledgeReminders().catch((err) => console.error('[pledge-reminder]', err.message));
setInterval(() => {
  sendDuePledgeReminders().catch((err) => console.error('[pledge-reminder]', err.message));
}, ONE_DAY_MS);

// Daily at midnight server time — auto-completes campaigns whose deadline
// has passed and notifies the creator + donors.
cron.schedule('0 0 * * *', () => {
  closeExpiredCampaigns().catch((err) => console.error('[campaignExpiry]', err.message));
});

// Every 5 minutes — flips stale pending donations to 'expired' once their
// payment_expires_at has passed (30 min for bank transfer, 24h for card/USSD).
// See Backend/services/paymentExpiryService.js.
cron.schedule('*/5 * * * *', () => {
  expireStalePayments().catch((err) => console.error('[paymentExpiry]', err.message));
});

// Paystack dashboard setup for payment-method selection (card / bank transfer /
// USSD): Settings -> Preferences -> Payment Channels must have Bank Transfer
// and USSD switched on for the live secret key's account, or Paystack will
// silently fall back to card-only on the hosted checkout page regardless of
// the `channels` array sent from initiateTransaction() in paystackService.js.

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Giviit backend running on port ${PORT}`));

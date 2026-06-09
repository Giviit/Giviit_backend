const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
dotenv.config();

let transporter;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendEmail({ to, subject, html, text }) {
  if (!transporter) {
    console.warn('[email] No SMTP configured — skipping email to', to);
    return;
  }
  await transporter.sendMail({ from: process.env.EMAIL_FROM, to, subject, html, text });
}

function fmt(amount) {
  return '₦' + Number(amount).toLocaleString('en-NG');
}

function wrap(body) {
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
      <div style="background:linear-gradient(135deg,#1a7a4a,#22c55e);padding:28px 32px">
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:900">Giviit</h1>
        <p style="color:rgba(255,255,255,.7);margin:4px 0 0;font-size:12px;letter-spacing:.08em">TOGETHER WE RISE</p>
      </div>
      <div style="padding:32px">${body}</div>
      <div style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb">
        <p style="margin:0;font-size:11px;color:#9ca3af">This email was sent by Giviit · <a href="https://giviit.ng" style="color:#1a7a4a">giviit.ng</a></p>
      </div>
    </div>`;
}

async function welcomeEmail(user) {
  await sendEmail({
    to: user.email,
    subject: `Welcome to Giviit, ${user.full_name.split(' ')[0]}!`,
    html: wrap(`
      <h2 style="margin:0 0 12px;color:#111827">Welcome, ${user.full_name.split(' ')[0]}! 🎉</h2>
      <p style="color:#4b5563">Your Giviit account is ready. Start a campaign in minutes and let your community support you.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#1a7a4a;color:#fff;border-radius:8px;font-weight:700;text-decoration:none">Go to Dashboard</a>
    `),
  });
}

async function donorReceipt(to, { campaign_title, amount, reference, campaign_url }) {
  await sendEmail({
    to,
    subject: `Donation confirmed — ${campaign_title}`,
    html: wrap(`
      <h2 style="margin:0 0 8px;color:#111827">Thank you for your donation! 🙏</h2>
      <p style="color:#4b5563">Your donation of <strong>${fmt(amount)}</strong> to <strong>${campaign_title}</strong> has been received.</p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:20px 0">
        <p style="margin:0;font-size:13px;color:#166534">Reference: <strong>${reference}</strong></p>
      </div>
      <a href="${campaign_url}" style="display:inline-block;padding:12px 24px;background:#1a7a4a;color:#fff;border-radius:8px;font-weight:700;text-decoration:none">View Campaign</a>
    `),
  });
}

async function campaignApproved(to, { campaign_title, campaign_url }) {
  await sendEmail({
    to,
    subject: `Your campaign is live — ${campaign_title}`,
    html: wrap(`
      <h2 style="margin:0 0 8px;color:#111827">Your campaign is live! 🚀</h2>
      <p style="color:#4b5563"><strong>${campaign_title}</strong> has been verified and is now visible to donors across Nigeria.</p>
      <p style="color:#4b5563">Start sharing your campaign link on WhatsApp, Instagram, and Twitter to reach more donors.</p>
      <a href="${campaign_url}" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1a7a4a;color:#fff;border-radius:8px;font-weight:700;text-decoration:none">View Campaign</a>
    `),
  });
}

async function campaignRejected(to, { campaign_title, reason }) {
  await sendEmail({
    to,
    subject: `Campaign review update — ${campaign_title}`,
    html: wrap(`
      <h2 style="margin:0 0 8px;color:#111827">Campaign not approved</h2>
      <p style="color:#4b5563">We were unable to approve <strong>${campaign_title}</strong> at this time.</p>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0">
        <p style="margin:0;color:#991b1b;font-size:13px"><strong>Reason:</strong> ${reason}</p>
      </div>
      <p style="color:#4b5563">You may edit your campaign and resubmit for review.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;padding:12px 24px;background:#1a7a4a;color:#fff;border-radius:8px;font-weight:700;text-decoration:none">Edit Campaign</a>
    `),
  });
}

async function campaignFraudulent(to, { campaign_title, amount }) {
  await sendEmail({
    to,
    subject: `Important: Refund processing — ${campaign_title}`,
    html: wrap(`
      <h2 style="margin:0 0 8px;color:#111827">Campaign removed — refund processing</h2>
      <p style="color:#4b5563">We discovered that <strong>${campaign_title}</strong> did not meet Giviit's trust standards.</p>
      <p style="color:#4b5563">Your donation of <strong>${fmt(amount)}</strong> is being refunded. Please allow <strong>3–5 business days</strong> for the funds to appear in your account.</p>
      <p style="color:#4b5563">If you have questions, contact us at <a href="mailto:trust@giviit.ng" style="color:#1a7a4a">trust@giviit.ng</a>.</p>
    `),
  });
}

async function withdrawalProcessing(to, { amount, bank_last4 }) {
  await sendEmail({
    to,
    subject: 'Withdrawal processing — Giviit',
    html: wrap(`
      <h2 style="margin:0 0 8px;color:#111827">Your withdrawal is processing</h2>
      <p style="color:#4b5563"><strong>${fmt(amount)}</strong> is being sent to your bank account ending in <strong>${bank_last4}</strong>.</p>
      <p style="color:#4b5563">This usually completes within a few hours during business days.</p>
    `),
  });
}

async function withdrawalCompleted(to, { amount }) {
  await sendEmail({
    to,
    subject: `₦${Number(amount).toLocaleString()} sent to your bank — Giviit`,
    html: wrap(`
      <h2 style="margin:0 0 8px;color:#111827">Funds sent! 💸</h2>
      <p style="color:#4b5563"><strong>${fmt(amount)}</strong> has been sent to your bank account. Check your bank for confirmation.</p>
    `),
  });
}

async function withdrawalFailed(to, { amount, reason }) {
  await sendEmail({
    to,
    subject: 'Withdrawal failed — Giviit',
    html: wrap(`
      <h2 style="margin:0 0 8px;color:#111827">Withdrawal could not be processed</h2>
      <p style="color:#4b5563">Your withdrawal of <strong>${fmt(amount)}</strong> failed.</p>
      ${reason ? `<p style="color:#4b5563"><strong>Reason:</strong> ${reason}</p>` : ''}
      <p style="color:#4b5563">Please contact <a href="mailto:support@giviit.ng" style="color:#1a7a4a">support@giviit.ng</a> for help.</p>
    `),
  });
}

async function kycVerified(to) {
  await sendEmail({
    to,
    subject: 'Identity verified — You can now withdraw funds',
    html: wrap(`
      <h2 style="margin:0 0 8px;color:#111827">Identity verified ✅</h2>
      <p style="color:#4b5563">Your identity has been successfully verified. You can now request withdrawals for your campaigns.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1a7a4a;color:#fff;border-radius:8px;font-weight:700;text-decoration:none">Go to Dashboard</a>
    `),
  });
}

async function kycFailed(to) {
  await sendEmail({
    to,
    subject: 'Verification unsuccessful — Please try again',
    html: wrap(`
      <h2 style="margin:0 0 8px;color:#111827">Verification unsuccessful</h2>
      <p style="color:#4b5563">We were unable to verify your identity. Please try again with a clearer ID document and ensure the selfie matches.</p>
      <a href="${process.env.FRONTEND_URL}/dashboard/kyc" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#1a7a4a;color:#fff;border-radius:8px;font-weight:700;text-decoration:none">Try Again</a>
    `),
  });
}

async function sendAdminAlert(subject, data) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;
  await sendEmail({
    to: adminEmail,
    subject: `[Giviit Admin] ${subject}`,
    html: wrap(`<h2>${subject}</h2><pre style="background:#f3f4f6;padding:16px;border-radius:8px;font-size:12px">${JSON.stringify(data, null, 2)}</pre>`),
  });
}

module.exports = {
  sendEmail,
  welcomeEmail,
  donorReceipt,
  campaignApproved,
  campaignRejected,
  campaignFraudulent,
  withdrawalProcessing,
  withdrawalCompleted,
  withdrawalFailed,
  kycVerified,
  kycFailed,
  sendAdminAlert,
};

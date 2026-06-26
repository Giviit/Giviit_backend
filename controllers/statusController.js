const { supabase } = require('../utils/supabaseClient');

async function checkSupabase() {
  try {
    const { error } = await supabase.from('profiles').select('id').limit(1);
    if (error) return { connected: false, detail: error.message };
    return { connected: true, detail: 'Query succeeded' };
  } catch (err) {
    return { connected: false, detail: err.message };
  }
}

function checkConfigured(...envVars) {
  return envVars.every(v => !!process.env[v]);
}

async function buildStatus() {
  const supabaseStatus = await checkSupabase();
  return {
    supabase: supabaseStatus,
    paystack: { configured: checkConfigured('PAYSTACK_SECRET_KEY') },
    cloudinary: { configured: checkConfigured('CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET') },
    email: { configured: checkConfigured('SMTP_HOST', 'SMTP_USER', 'SMTP_PASS') || checkConfigured('RESEND_API_KEY') },
    jwt: { configured: checkConfigured('JWT_SECRET') },
  };
}

// JSON — for the frontend or any automated check to consume directly.
async function getStatusJSON(req, res) {
  const status = await buildStatus();
  res.json(status);
}

// Human-readable HTML page — for eyeballing connectivity in a browser.
async function getStatusPage(req, res) {
  const status = await buildStatus();

  const row = (label, ok, detail) => `
    <tr>
      <td style="padding:12px 16px;font-weight:600;color:#111827">${label}</td>
      <td style="padding:12px 16px">
        <span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:${ok ? '#15803d' : '#b91c1c'}">
          <span style="width:8px;height:8px;border-radius:50%;background:${ok ? '#22c55e' : '#ef4444'};display:inline-block"></span>
          ${ok ? 'Connected' : 'Not connected'}
        </span>
      </td>
      <td style="padding:12px 16px;color:#6b7280;font-size:13px">${detail}</td>
    </tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Giviit Backend Status</title>
<meta name="robots" content="noindex">
</head>
<body style="font-family:system-ui,sans-serif;background:#f9fafb;margin:0;padding:40px 20px">
<div style="max-width:640px;margin:0 auto">
  <h1 style="font-size:20px;font-weight:900;color:#111827;margin:0 0 4px">Giviit Backend Status</h1>
  <p style="color:#9ca3af;font-size:13px;margin:0 0 24px">Checked at ${new Date().toLocaleString('en-NG')}</p>
  <table style="width:100%;background:#fff;border-radius:12px;border:1px solid #e5e7eb;border-collapse:collapse;overflow:hidden">
    ${row('Supabase', status.supabase.connected, status.supabase.detail)}
    ${row('Paystack key', status.paystack.configured, status.paystack.configured ? 'PAYSTACK_SECRET_KEY is set' : 'PAYSTACK_SECRET_KEY missing — donations/withdrawals will fail')}
    ${row('Cloudinary', status.cloudinary.configured, status.cloudinary.configured ? 'Upload credentials set' : 'Cloudinary env vars missing — image uploads will fail')}
    ${row('Email (SMTP/Resend)', status.email.configured, status.email.configured ? 'Email sending configured' : 'No SMTP/Resend configured — emails are silently skipped')}
    ${row('JWT secret', status.jwt.configured, status.jwt.configured ? 'JWT_SECRET is set' : 'JWT_SECRET missing — password reset & Google login will break')}
  </table>
  <p style="color:#9ca3af;font-size:12px;margin-top:20px">JSON version at <a href="/api/status" style="color:#1a7a4a">/api/status</a></p>
</div>
</body>
</html>`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = { getStatusJSON, getStatusPage };

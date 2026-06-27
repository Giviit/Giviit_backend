const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { supabase } = require('../utils/supabaseClient');
const { createAuthClient } = require('../utils/supabaseAuthClient');
const { sendEmail, sendAdminAlert } = require('../services/emailService');
const { getSettings } = require('../services/settingsService');

const CURRENT_TERMS_VERSION = '1.0';
const RESET_TOKEN_EXPIRY = '1h';

// NIN is sensitive PII — never store it in plaintext. A one-way hash still lets
// us enforce "this identity can only verify one account" via a uniqueness check.
function hashNin(nin) {
  return crypto.createHash('sha256').update(nin).digest('hex');
}

async function register(req, res, next) {
  try {
    const { allowNewRegistrations } = await getSettings();
    if (!allowNewRegistrations) {
      return res.status(403).json({ error: 'New registrations are temporarily closed. Please check back later.', code: 'REGISTRATIONS_CLOSED' });
    }

    const { full_name, email, phone, password, terms_agreed, identity_agreement_accepted } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!terms_agreed) {
      return res.status(400).json({ error: 'You must agree to the Terms of Service, Privacy Policy, and Cookie Policy to create an account.' });
    }
    if (!identity_agreement_accepted) {
      return res.status(400).json({ error: 'You must confirm the accuracy of your information and agree to our Anti-Fraud Policy to create an account.' });
    }

    // Real signup (not the admin API) so Supabase sends its own verification
    // email — this requires "Confirm email" to be enabled in the Supabase
    // project's Auth settings (Authentication → Providers → Email).
    const { data, error } = await createAuthClient().auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${process.env.FRONTEND_URL}/verify-email/success`,
        data: { full_name, phone },
      },
    });
    if (error) return res.status(400).json({ error: error.message });
    if (!data.user) return res.status(400).json({ error: 'Registration failed' });

    const { data: profile, error: profileError } = await supabase.from('profiles').insert([{
      id: data.user.id,
      full_name,
      email,
      phone,
      role: 'user',
      terms_agreed: true,
      terms_agreed_at: new Date().toISOString(),
      terms_version: CURRENT_TERMS_VERSION,
      identity_agreement_accepted: true,
      identity_agreement_accepted_at: new Date().toISOString(),
      is_email_verified: false,
    }]).select().single();

    if (profileError) {
      // Don't leave an orphaned auth user with no profile — they'd be unable to
      // register again with the same email, but also unable to log in.
      await supabase.auth.admin.deleteUser(data.user.id);
      return res.status(400).json({ error: profileError.message });
    }

    // If "Confirm email" is OFF in the Supabase project, signUp already
    // returns a live session — the account is verified by definition, so log
    // them straight in instead of showing a pointless "check your email" step.
    if (data.session) {
      await supabase.from('profiles').update({ is_email_verified: true, email_verified_at: new Date().toISOString() }).eq('id', data.user.id);
      try {
        await sendEmail({ to: email, subject: 'Welcome to Giviit', text: `Welcome ${full_name}! Your account has been created.` });
      } catch {}
      return res.status(201).json({
        token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        user: { id: data.user.id, email, ...profile, is_email_verified: true },
      });
    }

    res.status(201).json({ message: 'Check your email to verify your account', email });
  } catch (err) {
    next(err);
  }
}

// In-memory per-email rate limit for resend requests — a single backend
// process, so this is enough to stop someone hammering the resend button
// without needing a DB table just for counters.
const resendAttempts = new Map();
const RESEND_WINDOW_MS = 60 * 60 * 1000;
const RESEND_MAX = 3;

async function resendVerification(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const now = Date.now();
    const attempts = (resendAttempts.get(email) || []).filter((t) => now - t < RESEND_WINDOW_MS);
    if (attempts.length >= RESEND_MAX) {
      return res.status(429).json({ error: 'Too many resend attempts. Please try again in an hour.' });
    }
    attempts.push(now);
    resendAttempts.set(email, attempts);

    try {
      await createAuthClient().auth.resend({ type: 'signup', email });
    } catch {}

    // Same response regardless of outcome — avoids confirming/denying whether
    // an email is registered or already verified.
    res.json({ message: 'Verification email resent' });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    // Throwaway client — signing in on the shared service-role client would
    // downgrade every later query on it to this user's (RLS-limited) permissions.
    const { data, error } = await createAuthClient().auth.signInWithPassword({ email, password });
    if (error) {
      if (error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message || '')) {
        return res.status(403).json({ error: 'Please verify your email before logging in', code: 'EMAIL_NOT_VERIFIED', email });
      }
      return res.status(400).json({ error: error.message });
    }

    // Get profile via the service-role client (bypasses RLS, never touched by sign-in)
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (profileError) return next(profileError);

    if (!profile.is_email_verified) {
      await supabase.from('profiles').update({ is_email_verified: true, email_verified_at: new Date().toISOString() }).eq('id', data.user.id);
      profile.is_email_verified = true;
    }

    if (!profile?.terms_agreed) {
      return res.status(403).json({
        error: 'You must accept our Terms of Service, Privacy Policy, and Cookie Policy before signing in.',
        code: 'TERMS_NOT_AGREED',
      });
    }

    if (!profile?.identity_agreement_accepted) {
      return res.status(403).json({
        error: 'You must confirm the accuracy of your information and agree to our Anti-Fraud Policy before signing in.',
        code: 'IDENTITY_AGREEMENT_NOT_AGREED',
      });
    }

    const user = {
      id: data.user.id,
      email: data.user.email,
      ...profile,
    };

    return res.json({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      user,
    });
  } catch (err) {
    next(err);
  }
}

async function refreshToken(req, res, next) {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Missing refresh token' });

    // Throwaway client, same reason as login()/register() — never call a
    // session-mutating auth method on the shared service-role client.
    const { data, error } = await createAuthClient().auth.refreshSession({ refresh_token });
    if (error || !data.session) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    res.json({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  } catch (err) {
    next(err);
  }
}

function logout(req, res) {
  // Stateless bearer-token API — there's no server-side session to invalidate.
  // The client just discards its token; this endpoint exists for symmetry.
  res.json({ message: 'Logged out' });
}

async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('email', email)
      .single();

    // Always respond 200 to prevent email enumeration
    if (!profile) return res.json({ message: 'If that email is registered, a reset link has been sent.' });

    const token = jwt.sign(
      { sub: profile.id, purpose: 'password_reset' },
      process.env.JWT_SECRET,
      { expiresIn: RESET_TOKEN_EXPIRY }
    );

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

    await sendEmail({
      to: email,
      subject: 'Reset your Giviit password',
      html: `<p>Hi ${profile.full_name},</p>
<p>Click the link below to reset your password. This link expires in 1 hour.</p>
<p><a href="${resetUrl}">Reset Password</a></p>
<p>If you did not request this, ignore this email.</p>`,
    });

    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Missing token or password' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    if (payload.purpose !== 'password_reset') {
      return res.status(400).json({ error: 'Invalid reset token' });
    }

    const { error } = await supabase.auth.admin.updateUserById(payload.sub, { password });
    if (error) return res.status(400).json({ error: 'Failed to reset password. Please try again.' });

    res.json({ message: 'Password reset successful' });
  } catch (err) {
    next(err);
  }
}

// Step 1: browser hits this directly (window.location.href = .../auth/google).
// We redirect to Supabase's GoTrue authorize endpoint, which runs the actual
// Google OAuth handshake and redirects back to our bridge page below.
function googleRedirect(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.redirect(`${frontendUrl}/login?error=${encodeURIComponent('Google sign-in is not configured')}`);
  }
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
  // Carries the "user checked the agree box" signal through the redirect chain —
  // Supabase appends the session token as a hash fragment to whatever we pass here.
  const agreed = req.query.agreed === 'true' ? '?agreed=true' : '';
  const redirectTo = `${backendUrl}/api/auth/google/bridge${agreed}`;
  const authorizeUrl = `${supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
  res.redirect(authorizeUrl);
}

// Step 2: Supabase redirects here after Google approves, with the session token
// in the URL *hash fragment* — fragments never reach the server, so this tiny
// page reads it client-side, hands it to googleSync below to upsert the profile,
// then forwards the same (real, Supabase-issued) access token to the frontend.
function googleBridge(req, res) {
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:5000';
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html><head><title>Signing in&hellip;</title></head>
<body>
<p>Signing you in&hellip;</p>
<script>
(function () {
  var hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  var params = new URLSearchParams(hash);
  var errorDesc = params.get('error_description') || params.get('error');
  var accessToken = params.get('access_token');
  var refreshToken = params.get('refresh_token');
  var frontendUrl = ${JSON.stringify(frontendUrl)};
  var agreed = new URLSearchParams(window.location.search).get('agreed') === 'true';

  function fail(msg, code) {
    var url = frontendUrl + '/login?error=' + encodeURIComponent(msg || 'Google sign-in failed');
    if (code) url += '&code=' + encodeURIComponent(code);
    window.location.href = url;
  }

  if (errorDesc) return fail(errorDesc);
  if (!accessToken) return fail('Google sign-in failed');

  fetch(${JSON.stringify(backendUrl)} + '/api/auth/google/sync?agreed=' + agreed, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken },
  })
    .then(function (r) {
      if (r.status === 403) return r.json().then(function (b) { fail(b.error, b.code); });
      if (!r.ok) throw new Error('sync failed');
      return r.json().then(function () {
        var url = frontendUrl + '/auth/callback?token=' + encodeURIComponent(accessToken);
        if (refreshToken) url += '&refresh_token=' + encodeURIComponent(refreshToken);
        window.location.href = url;
      });
    })
    .catch(function () { fail('Could not complete Google sign-in'); });
})();
</script>
</body></html>`);
}

async function googleSync(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const agreed = req.query.agreed === 'true' || req.body?.agreed === true;

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

    const { id, email } = user;

    // Google OAuth via Supabase creates the auth.users row automatically before
    // we ever see this request — but we control whether a *profile* gets created,
    // and the rest of the app requires a profile to treat someone as signed in
    // (see authenticateUser middleware). So a missing profile + no consent =
    // effectively blocked, exactly like email/password registration.
    const { data: existing } = await supabase.from('profiles').select('id').eq('id', id).single();

    if (!existing && !agreed) {
      return res.status(403).json({
        error: 'You must agree to the Terms of Service, Privacy Policy, Cookie Policy, and our Anti-Fraud Policy to create an account.',
        code: 'TERMS_NOT_AGREED',
      });
    }

    const full_name = user.user_metadata?.full_name || user.user_metadata?.name || email.split('@')[0];
    const avatar_url = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;

    const payload = { id, email, full_name, avatar_url, role: 'user' };
    if (!existing) {
      // First-time signup, consent just given — record it. Never overwrite an
      // existing user's consent record on subsequent logins.
      payload.terms_agreed = true;
      payload.terms_agreed_at = new Date().toISOString();
      payload.terms_version = CURRENT_TERMS_VERSION;
      payload.identity_agreement_accepted = true;
      payload.identity_agreement_accepted_at = new Date().toISOString();
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .upsert(payload, { onConflict: 'id' })
      .select()
      .single();

    if (profileError) return res.status(400).json({ error: profileError.message });

    return res.json({ token, user: { id, email, ...profile } });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

async function submitBanAppeal(req, res, next) {
  try {
    const { message } = req.body;
    if (!req.user.is_banned) return res.status(400).json({ error: 'Your account is not currently suspended' });
    if (req.user.ban_appeal_status === 'pending') return res.status(400).json({ error: 'An appeal is already under review' });
    if (!message || message.trim().length < 20) {
      return res.status(400).json({ error: 'Appeal message must be at least 20 characters' });
    }

    await supabase.from('profiles').update({
      ban_appeal_message: message,
      ban_appeal_status: 'pending',
      ban_appeal_submitted_at: new Date().toISOString(),
    }).eq('id', req.user.id);

    try {
      await sendAdminAlert('New account ban appeal', { user: req.user.email, message });
    } catch {}

    res.json({ message: 'Appeal submitted' });
  } catch (err) {
    next(err);
  }
}

async function verifyIdentity(req, res, next) {
  try {
    const userId = req.user.id;
    const { nin, selfie_url, id_document_url, identity_agreement_accepted } = req.body;

    if (!nin || !/^\d{11}$/.test(nin)) {
      return res.status(400).json({ error: 'NIN must be exactly 11 digits' });
    }
    if (!selfie_url || !id_document_url) {
      return res.status(400).json({ error: 'Selfie and government ID photos are required' });
    }
    if (!identity_agreement_accepted) {
      return res.status(400).json({ error: 'You must confirm the accuracy of your information and agree to our Anti-Fraud Policy.' });
    }

    const ninHash = hashNin(nin);

    // Fraud check: the same identity can't verify a second, different account.
    const { data: duplicates } = await supabase
      .from('profiles')
      .select('id')
      .eq('nin', ninHash)
      .neq('id', userId);

    if (duplicates && duplicates.length > 0) {
      return res.status(409).json({ error: 'This NIN is already linked to another Giviit account.' });
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .update({
        nin: ninHash,
        selfie_url,
        id_document_url,
        verification_status: 'pending',
        verification_submitted_at: new Date().toISOString(),
        identity_agreement_accepted: true,
        identity_agreement_accepted_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    res.json({ message: 'Verification documents submitted. Review takes 24-48 hours.', user: { ...req.user, ...profile } });
  } catch (err) {
    next(err);
  }
}

async function updateProfile(req, res, next) {
  try {
    const userId = req.user.id;
    const { full_name, phone, avatar_url, bank_name, bank_account_number, bank_account_name, cookie_consent } = req.body;

    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (bank_name !== undefined) updates.bank_name = bank_name;
    if (bank_account_number !== undefined) updates.bank_account_number = bank_account_number;
    if (bank_account_name !== undefined) updates.bank_account_name = bank_account_name;
    if (cookie_consent !== undefined) {
      updates.cookie_consent = cookie_consent;
      updates.cookie_consent_at = new Date().toISOString();
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    const user = { ...req.user, ...profile };
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, logout, forgotPassword, resetPassword, refreshToken, resendVerification, googleRedirect, googleBridge, googleSync, me, updateProfile, verifyIdentity, submitBanAppeal };

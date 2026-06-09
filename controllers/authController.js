const { supabase } = require('../utils/supabaseClient');
const { sendEmail } = require('../services/emailService');

const CURRENT_TERMS_VERSION = '1.0';

async function register(req, res, next) {
  try {
    const { full_name, email, phone, password, terms_agreed } = req.body;
    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!terms_agreed) {
      return res.status(400).json({ error: 'You must agree to the Terms of Service, Privacy Policy, and Cookie Policy to create an account.' });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { full_name, phone, role: 'user' },
      email_confirm: false,
    });
    if (error) return res.status(400).json({ error: error.message });

    const { error: profileError } = await supabase.from('profiles').insert([{
      id: data.user.id,
      full_name,
      email,
      phone,
      role: 'user',
      terms_agreed: true,
      terms_agreed_at: new Date().toISOString(),
      terms_version: CURRENT_TERMS_VERSION,
    }]);

    if (profileError) return res.status(400).json({ error: profileError.message });

    try {
      await sendEmail({
        to: email,
        subject: 'Welcome to Giviit',
        text: `Welcome ${full_name}! Your account has been created.`,
      });
    } catch {}

    res.status(201).json({ message: 'Account created. Please check your email.' });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: error.message });

    // Get profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', data.user.id)
      .single();

    if (!profile?.terms_agreed) {
      return res.status(403).json({
        error: 'You must accept our Terms of Service, Privacy Policy, and Cookie Policy before signing in.',
        code: 'TERMS_NOT_AGREED',
      });
    }

    const user = {
      id: data.user.id,
      email: data.user.email,
      ...profile,
    };

    return res.json({
      token: data.session.access_token,
      user,
    });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    await supabase.auth.signOut();
    res.json({ message: 'Logged out' });
  } catch (err) {
    next(err);
  }
}

async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
    });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Password reset email sent' });
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { password, user_id } = req.body;
    if (!password || !user_id) {
      return res.status(400).json({ error: 'Missing user_id or password' });
    }
    const { error } = await supabase.auth.admin.updateUserById(user_id, { password });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ message: 'Password reset successful' });
  } catch (err) {
    next(err);
  }
}

async function googleSync(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

    const { id, email } = user;
    const full_name = user.user_metadata?.full_name || user.user_metadata?.name || email.split('@')[0];
    const avatar_url = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .upsert(
        {
          id,
          email,
          full_name,
          avatar_url,
          role: 'user',
          terms_agreed: true,
          terms_agreed_at: new Date().toISOString(),
          terms_version: CURRENT_TERMS_VERSION,
        },
        { onConflict: 'id' }
      )
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

async function updateProfile(req, res, next) {
  try {
    const userId = req.user.id;
    const { full_name, phone, avatar_url, bank_name, bank_account_number, bank_account_name } = req.body;

    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;
    if (avatar_url !== undefined) updates.avatar_url = avatar_url;
    if (bank_name !== undefined) updates.bank_name = bank_name;
    if (bank_account_number !== undefined) updates.bank_account_number = bank_account_number;
    if (bank_account_name !== undefined) updates.bank_account_name = bank_account_name;

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

module.exports = { register, login, logout, forgotPassword, resetPassword, googleSync, me, updateProfile };

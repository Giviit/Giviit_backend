const { supabase } = require('../utils/supabaseClient');

async function authenticateUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const { data: userInfo, error } = await supabase.auth.getUser(token);
    if (error || !userInfo?.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userInfo.user.id)
      .single();

    if (profileError || !profile) {
      return res.status(401).json({ error: 'Profile not found' });
    }

    // Merge auth user + profile so req.user.id, req.user.role etc. work directly
    req.user = {
      id: userInfo.user.id,
      email: userInfo.user.email,
      ...profile,
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticateUser };

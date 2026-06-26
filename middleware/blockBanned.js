function blockBanned(req, res, next) {
  if (req.user?.is_banned) {
    return res.status(403).json({
      error: 'Your account has been suspended.',
      code: 'ACCOUNT_BANNED',
      ban_reason: req.user.ban_reason || null,
      ban_appeal_status: req.user.ban_appeal_status || 'none',
    });
  }
  next();
}

module.exports = { blockBanned };

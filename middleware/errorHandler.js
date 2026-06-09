function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  console.error(`[${status}] ${req.method} ${req.path} —`, err.message);
  const message = status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
}

module.exports = { errorHandler };

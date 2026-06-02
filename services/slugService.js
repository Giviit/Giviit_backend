function generateSlug(title) {
  const sanitized = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  const randomPart = Math.random().toString(36).substring(2, 8);
  return `${sanitized}-${randomPart}`;
}

module.exports = { generateSlug };

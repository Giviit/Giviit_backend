const { supabase } = require('../utils/supabaseClient');

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmt(amount) {
  return '₦' + Number(amount || 0).toLocaleString('en-NG');
}

async function getCampaignShareHTML(req, res) {
  const { slug } = req.params;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const destination = `${frontendUrl}/campaign/${encodeURIComponent(slug)}`;

  let title = 'Giviit — Together We Rise';
  let description = "Nigeria's crowdfunding platform — fund what matters most.";
  let image = `${frontendUrl}/og-default.png`;

  try {
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('title, description, cover_image, raised_amount, goal_amount')
      .eq('slug', slug)
      .single();

    if (campaign) {
      title = `Help ${campaign.title} | Giviit`;
      description = campaign.description
        ? campaign.description.slice(0, 200)
        : `${fmt(campaign.raised_amount)} raised of ${fmt(campaign.goal_amount)} goal. Every donation counts.`;
      if (campaign.cover_image) image = campaign.cover_image;
    }
  } catch {
    // fall through to defaults — still redirect below
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">

<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:url" content="${escapeHtml(destination)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Giviit">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(image)}">

<meta http-equiv="refresh" content="0;url=${escapeHtml(destination)}">
<script>window.location.replace(${JSON.stringify(destination)});</script>
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(destination)}">${escapeHtml(title)}</a>&hellip;</p>
</body>
</html>`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

module.exports = { getCampaignShareHTML };

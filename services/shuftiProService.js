const axios = require('axios');

function getAuthHeader() {
  const creds = Buffer.from(
    `${process.env.SHUFTI_CLIENT_ID}:${process.env.SHUFTI_SECRET_KEY}`
  ).toString('base64');
  return `Basic ${creds}`;
}

async function initiateVerification({ reference, user }) {
  const body = {
    reference,
    callback_url: `${process.env.BACKEND_URL}/api/kyc/webhook`,
    redirect_url: `${process.env.FRONTEND_URL}/dashboard/kyc/result`,
    country: 'NG',
    language: 'EN',
    verification_mode: 'any',
    document: {
      supported_types: ['passport', 'driving_license'],
      name: {
        first_name: user?.first_name || '',
        last_name: user?.last_name || '',
      },
      fetch_enhanced_data: '1',
      document_number: { value: user?.nin || '' },
    },
    face: { proof: '' },
  };

  const response = await axios.post('https://api.shuftipro.com/', body, {
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json',
    },
  });

  return response.data;
}

function verifyWebhookSignature(rawBody, signature) {
  const crypto = require('crypto');
  const computed = crypto
    .createHmac('sha256', process.env.SHUFTI_SECRET_KEY)
    .update(JSON.stringify(rawBody))
    .digest('hex');
  return computed === signature;
}

module.exports = { initiateVerification, verifyWebhookSignature };

const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
if (!PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY required');

const client = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
});

async function initiateTransaction({ email, amount, campaign_id, donor_name, is_anonymous, message, prayer, currency }) {
  const ref = `GIVIIT_DON_${campaign_id.slice(0, 8)}_${Date.now()}`;
  const body = {
    email,
    amount: Math.round(Number(amount) * 100),
    reference: ref,
    currency: currency || 'NGN',
    callback_url: `${process.env.FRONTEND_URL}/donate/success`,
    metadata: { campaign_id, donor_name, is_anonymous, message, prayer },
  };
  const { data } = await client.post('/transaction/initialize', body);
  return data.data;
}

async function verifyTransaction(reference) {
  const { data } = await client.get(`/transaction/verify/${reference}`);
  return data.data;
}

async function initiateRefund({ transaction, amount }) {
  const body = { transaction };
  if (amount) body.amount = Math.round(Number(amount) * 100);
  const { data } = await client.post('/refund', body);
  return data.data;
}

async function createTransferRecipient({ name, account_number, bank_code }) {
  const { data } = await client.post('/transferrecipient', {
    type: 'nuban',
    name,
    account_number,
    bank_code,
    currency: 'NGN',
  });
  return data.data;
}

async function transferToRecipient({ amount, recipient, reason, reference }) {
  const ref = reference || `GIVIIT_WD_${Date.now()}`;
  const { data } = await client.post('/transfer', {
    source: 'balance',
    amount: Math.round(Number(amount) * 100),
    recipient,
    reason,
    reference: ref,
  });
  return data.data;
}

async function getBalance() {
  const { data } = await client.get('/balance');
  const balance = data.data?.[0];
  return balance ? Number(balance.balance) / 100 : 0;
}

module.exports = {
  initiateTransaction,
  verifyTransaction,
  initiateRefund,
  createTransferRecipient,
  transferToRecipient,
  getBalance,
};

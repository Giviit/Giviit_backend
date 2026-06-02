-- Run this in Supabase SQL editor

-- Feature 1: Group Campaigns (Ajo Mode)
CREATE TABLE IF NOT EXISTS campaign_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT CHECK (role IN ('owner', 'co-owner')) DEFAULT 'co-owner',
  status TEXT CHECK (status IN ('pending', 'accepted')) DEFAULT 'pending',
  invited_email TEXT,
  invite_token TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Feature 2: Guarantor
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS guarantor_name TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS guarantor_email TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS guarantor_phone TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS guarantor_relationship TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS guarantor_status TEXT DEFAULT 'pending' CHECK (guarantor_status IN ('pending', 'vouched', 'declined'));
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS guarantor_message TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS guarantor_token TEXT;

-- Feature 3: Prayer Wall
ALTER TABLE donations ADD COLUMN IF NOT EXISTS prayer TEXT;
ALTER TABLE donations ADD COLUMN IF NOT EXISTS show_prayer BOOLEAN DEFAULT TRUE;

-- Feature 4: Birthday
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_birthday BOOLEAN DEFAULT FALSE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS birthday_date DATE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS birthday_person_name TEXT;

-- Feature 5: Milestones
CREATE TABLE IF NOT EXISTS campaign_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  amount NUMERIC NOT NULL,
  is_reached BOOLEAN DEFAULT FALSE,
  reached_at TIMESTAMPTZ,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Feature 6: Offline Donations
CREATE TABLE IF NOT EXISTS offline_donations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  creator_id UUID REFERENCES profiles(id),
  donor_name TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  note TEXT,
  donated_at DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Feature 7: Pledges
CREATE TABLE IF NOT EXISTS pledges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  donor_name TEXT NOT NULL,
  donor_email TEXT NOT NULL,
  total_amount NUMERIC NOT NULL,
  installment_amount NUMERIC NOT NULL,
  frequency TEXT CHECK (frequency IN ('weekly', 'biweekly', 'monthly')) DEFAULT 'monthly',
  installments_total INTEGER NOT NULL,
  installments_paid INTEGER DEFAULT 0,
  next_payment_date DATE,
  status TEXT CHECK (status IN ('active', 'completed', 'cancelled')) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Feature 8: Urgency
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS urgency_reason TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS urgency_deadline TIMESTAMPTZ;

-- Feature 10: Diaspora
ALTER TABLE donations ADD COLUMN IF NOT EXISTS donor_country TEXT;
ALTER TABLE donations ADD COLUMN IF NOT EXISTS donor_currency TEXT DEFAULT 'NGN';

-- Account types
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'individual' CHECK (account_type IN ('individual', 'ngo', 'charity'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS organization_name TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS organization_rc_number TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_verified_org BOOLEAN DEFAULT FALSE;

-- Creator verification fields
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS nin TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bvn TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS id_document_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS selfie_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected'));
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS verification_submitted_at TIMESTAMPTZ;

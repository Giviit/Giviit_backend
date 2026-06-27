const { supabase } = require('../utils/supabaseClient');
const { uploadDocument, deleteDocument } = require('../services/cloudinaryService');
const { getDocLabel } = require('../services/documentRequirementsService');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function base64SizeBytes(base64Data) {
  const commaIndex = base64Data.indexOf(',');
  const raw = commaIndex !== -1 ? base64Data.slice(commaIndex + 1) : base64Data;
  return Math.ceil((raw.length * 3) / 4);
}

// Creator uploads one document for their own campaign. Response intentionally
// never includes the Cloudinary URL — only the admin review endpoint does.
async function uploadCampaignDocument(req, res, next) {
  try {
    const { id } = req.params;
    const { document_type, file, is_required } = req.body;
    if (!document_type || !file) {
      return res.status(400).json({ error: 'document_type and file are required' });
    }

    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns').select('creator_id').eq('id', id).single();
    if (campaignError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const sizeBytes = base64SizeBytes(file);
    if (sizeBytes > MAX_FILE_SIZE) {
      return res.status(400).json({ error: 'File must be under 10MB' });
    }

    const isPdf = file.startsWith('data:application/pdf');
    const fileType = isPdf ? 'pdf' : (file.match(/^data:image\/(\w+);/)?.[1] || 'image');

    const { url, publicId } = await uploadDocument(file, isPdf);

    const { data, error } = await supabase
      .from('campaign_documents')
      .insert({
        campaign_id: id,
        creator_id: req.user.id,
        document_type,
        document_label: getDocLabel(document_type),
        cloudinary_public_id: publicId,
        cloudinary_url: url,
        file_type: fileType,
        file_size_bytes: sizeBytes,
        is_required: !!is_required,
      })
      .select('id')
      .single();
    if (error) throw error;

    res.json({ message: 'Document uploaded successfully', id: data.id });
  } catch (err) {
    next(err);
  }
}

// Creator's own view of their uploads — filenames/types only, never the
// Cloudinary URL (kept private to the admin review endpoint).
async function getCampaignDocumentsOwner(req, res, next) {
  try {
    const { id } = req.params;
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns').select('creator_id').eq('id', id).single();
    if (campaignError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

    const { data, error } = await supabase
      .from('campaign_documents')
      .select('id, document_type, document_label, file_type, is_required, admin_status, admin_note, created_at')
      .eq('campaign_id', id)
      .order('created_at', { ascending: true });
    if (error) throw error;

    res.json({ documents: data || [] });
  } catch (err) {
    next(err);
  }
}

// Only deletable before the campaign has left 'draft' (i.e. before publish).
async function deleteCampaignDocument(req, res, next) {
  try {
    const { id, doc_id } = req.params;
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns').select('creator_id, status').eq('id', id).single();
    if (campaignError) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.creator_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (campaign.status !== 'draft') {
      return res.status(400).json({ error: 'Documents can only be removed before the campaign is submitted for review' });
    }

    const { data: doc, error: docError } = await supabase
      .from('campaign_documents').select('*').eq('id', doc_id).eq('campaign_id', id).single();
    if (docError || !doc) return res.status(404).json({ error: 'Document not found' });

    try {
      await deleteDocument(doc.cloudinary_public_id, doc.file_type === 'pdf');
    } catch {}

    await supabase.from('campaign_documents').delete().eq('id', doc_id);
    res.json({ message: 'Document deleted' });
  } catch (err) {
    next(err);
  }
}

// Admin-only — the one place document URLs are ever returned.
async function getCampaignDocumentsAdmin(req, res, next) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from('campaign_documents')
      .select('*, reviewer:profiles!reviewed_by(full_name)')
      .eq('campaign_id', id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ documents: data || [] });
  } catch (err) {
    next(err);
  }
}

async function reviewCampaignDocument(req, res, next) {
  try {
    const { doc_id } = req.params;
    const { status, note } = req.body;
    if (!['verified', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "Status must be 'verified' or 'rejected'" });
    }

    const { data, error } = await supabase
      .from('campaign_documents')
      .update({ admin_status: status, admin_note: note || null, reviewed_by: req.user.id, reviewed_at: new Date().toISOString() })
      .eq('id', doc_id)
      .select()
      .single();
    if (error) throw error;

    res.json({ document: data });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  uploadCampaignDocument,
  getCampaignDocumentsOwner,
  deleteCampaignDocument,
  getCampaignDocumentsAdmin,
  reviewCampaignDocument,
};

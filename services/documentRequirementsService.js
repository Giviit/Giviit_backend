// Category-specific document requirements for campaign verification. Used by
// documentController (to label/validate uploads) and campaignController (to
// gate publishing until required documents are attached).

const DOC_LABELS = {
  hospital_letter: 'Hospital Letter',
  diagnosis_report: 'Diagnosis Report',
  medical_bills: 'Medical Bills',
  doctor_recommendation: "Doctor's Recommendation",
  proof_of_emergency: 'Proof of Emergency',
  supporting_document: 'Supporting Document',
  community_letter: 'Community Letter',
  admission_letter_or_school_id: 'Admission Letter or School ID',
  proof_of_enrollment: 'Proof of Enrollment',
  school_fee_invoice: 'School Fee Invoice',
  project_budget: 'Project Budget',
  supporting_photos: 'Supporting Photos',
  business_plan: 'Business Plan',
  cac_certificate: 'CAC Certificate',
  proof_of_concept: 'Proof of Concept',
  death_certificate: 'Death Certificate',
  burial_invoice: 'Burial Invoice',
  project_plan: 'Project Plan',
  church_letterhead: 'Church Letterhead',
};

const CATEGORY_DOCS = {
  medical: {
    required: ['hospital_letter', 'diagnosis_report'],
    optional: ['medical_bills', 'doctor_recommendation'],
    message: 'We require medical documentation to verify this campaign. These documents are strictly confidential and will never be shared publicly. They are used only by our trust team to confirm the authenticity of your campaign.',
  },
  emergency: {
    required: ['proof_of_emergency'],
    optional: ['supporting_document', 'community_letter'],
    message: 'Please provide documentation that confirms this emergency. All documents are kept strictly confidential and only reviewed by our team.',
  },
  education: {
    required: ['admission_letter_or_school_id'],
    optional: ['proof_of_enrollment', 'school_fee_invoice'],
    message: 'Education documents are required to verify this campaign. These are kept confidential and only used for verification purposes.',
  },
  community: {
    required: ['project_budget'],
    optional: ['community_letter', 'supporting_photos'],
    message: 'A project budget or community letter helps us verify your campaign. Documents are strictly confidential.',
  },
  business: {
    required: [],
    optional: ['business_plan', 'cac_certificate', 'proof_of_concept'],
    message: 'Supporting documents help build donor trust. All documents are kept confidential.',
  },
  funeral: {
    required: [],
    optional: ['death_certificate', 'burial_invoice'],
    message: 'Supporting documents are optional but help verify your campaign. Kept strictly confidential.',
  },
  church: {
    required: [],
    optional: ['project_plan', 'church_letterhead'],
    message: null,
  },
  other: {
    required: [],
    optional: [],
    message: null,
  },
};

function getCategoryDocs(category) {
  return CATEGORY_DOCS[category] || CATEGORY_DOCS.other;
}

function getRequiredDocs(category) {
  return getCategoryDocs(category).required;
}

function getDocLabel(type) {
  return DOC_LABELS[type] || type;
}

module.exports = { CATEGORY_DOCS, getCategoryDocs, getRequiredDocs, getDocLabel };

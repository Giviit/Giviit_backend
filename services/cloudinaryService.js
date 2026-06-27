const cloudinary = require('cloudinary').v2;
const dotenv = require('dotenv');
dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function uploadImage(base64Data, folder = 'Giviit') {
  const result = await cloudinary.uploader.upload(base64Data, {
    folder,
    resource_type: 'image',
    quality: 'auto',
  });
  return result.secure_url;
}

// Campaign verification documents (PDF/JPG/PNG) — uploaded to a private
// folder, never resized/transformed, and resource_type 'raw' for non-image
// files (e.g. PDFs) so Cloudinary stores them as-is.
async function uploadDocument(base64Data, isPdf) {
  const result = await cloudinary.uploader.upload(base64Data, {
    folder: 'giviit/documents/private',
    resource_type: isPdf ? 'raw' : 'image',
  });
  return { url: result.secure_url, publicId: result.public_id };
}

async function deleteDocument(publicId, isPdf) {
  await cloudinary.uploader.destroy(publicId, { resource_type: isPdf ? 'raw' : 'image' });
}

module.exports = { uploadImage, uploadDocument, deleteDocument };

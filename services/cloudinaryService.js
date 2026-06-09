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

module.exports = { uploadImage };

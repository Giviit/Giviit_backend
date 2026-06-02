const { uploadImage } = require('../services/cloudinaryService');

async function uploadImageHandler(req, res, next) {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ message: 'Image required' });
    const url = await uploadImage(image);
    res.json({ url });
  } catch (err) {
    next(err);
  }
}

module.exports = { uploadImageHandler };

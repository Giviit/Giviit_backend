const PDFDocument = require('pdfkit');

function fmtAmount(amount, currency = 'NGN') {
  const symbol = currency === 'NGN' ? '₦' : `${currency} `;
  return `${symbol}${Number(amount).toLocaleString('en-NG')}`;
}

// Draws the Giviit mark (rounded green square + "G" stroke) without needing
// an external image/font asset — keeps the backend self-contained.
function drawLogo(doc, x, y) {
  const size = 40;
  doc.roundedRect(x, y, size, size, 9).fill('#1a7a4a');

  doc.save();
  doc.lineWidth(3).strokeColor('#ffffff').lineCap('round').lineJoin('round');
  const cx = x + size * 0.52, cy = y + size * 0.55, r = size * 0.26;
  doc.path(`M ${cx + r} ${cy - r} A ${r} ${r} 0 1 0 ${cx + r} ${cy + r} L ${cx + r} ${cy} L ${cx} ${cy}`).stroke();
  doc.restore();

  const wordX = x + size + 12;
  doc.font('Helvetica-Bold').fontSize(20);
  doc.fillColor('#0f1f0f').text('Giv', wordX, y + 6, { continued: true });
  doc.fillColor('#f5a623').text('ii', { continued: true });
  doc.fillColor('#0f1f0f').text('t');
  doc.font('Helvetica').fontSize(7.5).fillColor('#6b7280').text('TOGETHER WE RISE', wordX, y + 28);
}

function generateReceiptPdf({ reference, donor_name, donor_email, amount, currency, campaign_title, donated_at, is_anonymous }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      drawLogo(doc, 50, 45);
      doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e5e7eb').lineWidth(1).stroke();

      doc.fillColor('#111827').font('Helvetica-Bold').fontSize(18).text('Donation Receipt', 50, 125);
      doc.fillColor('#6b7280').font('Helvetica').fontSize(10)
        .text(`Reference: ${reference}`, 50, 150)
        .text(`Date: ${new Date(donated_at || Date.now()).toLocaleString('en-NG')}`, 50, 165);

      const boxY = 195;
      doc.roundedRect(50, boxY, 495, 140, 8).fillAndStroke('#f9fafb', '#e5e7eb');

      const rows = [
        ['Donor', is_anonymous ? 'Anonymous' : (donor_name || 'Anonymous')],
        ['Email', donor_email || '-'],
        ['Campaign', campaign_title || '-'],
        ['Amount', fmtAmount(amount, currency)],
      ];
      let rowY = boxY + 20;
      rows.forEach(([label, value]) => {
        doc.fillColor('#6b7280').font('Helvetica').fontSize(10).text(label, 70, rowY);
        doc.fillColor('#111827').font('Helvetica-Bold').fontSize(12).text(String(value), 200, rowY - 1, { width: 320 });
        rowY += 30;
      });

      doc.fillColor('#9ca3af').font('Helvetica').fontSize(9)
        .text('This receipt confirms your donation was successfully processed via Paystack.', 50, 365)
        .text('Giviit — giviit.ng', 50, 380);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateReceiptPdf };

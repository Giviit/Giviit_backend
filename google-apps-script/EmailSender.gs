/**
 * Giviit — Email sender via Gmail (Google Apps Script)
 *
 * Lets the backend send emails through a Gmail account for free instead of
 * paying for SMTP/Resend, useful while testing. Supports a PDF attachment
 * (used for donation receipts).
 *
 * ── Setup ──
 * 1. Go to https://script.google.com and create a New Project.
 * 2. Delete the default code and paste this whole file in.
 * 3. Set a secret so randoms can't use your Gmail to send spam:
 *      Project Settings (gear icon, left sidebar) → Script Properties → Add property
 *      Name:  EMAIL_SECRET
 *      Value: any long random string (e.g. generate one and keep it safe)
 * 4. Deploy → New deployment → type: "Web app"
 *      Execute as:        Me (giviitng@gmail.com)
 *      Who has access:    Anyone
 * 5. Click Deploy, authorize the permissions it asks for (it needs Gmail send access).
 * 6. Copy the Web app URL it gives you.
 * 7. Send me that URL + the EMAIL_SECRET value you set in step 3, and I'll wire
 *    them into Backend/.env as APPS_SCRIPT_EMAIL_URL and APPS_SCRIPT_EMAIL_SECRET.
 *
 * Free Gmail accounts can send ~100 emails/day this way — plenty for testing.
 */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('EMAIL_SECRET');

    if (!expectedSecret || body.secret !== expectedSecret) {
      return jsonResponse({ success: false, error: 'Unauthorized' });
    }
    if (!body.to || !body.subject) {
      return jsonResponse({ success: false, error: 'Missing to/subject' });
    }

    const options = { htmlBody: body.html || body.text || '' };

    if (body.attachmentBase64 && body.attachmentName) {
      const blob = Utilities.newBlob(
        Utilities.base64Decode(body.attachmentBase64),
        body.attachmentType || 'application/pdf',
        body.attachmentName
      );
      options.attachments = [blob];
    }

    GmailApp.sendEmail(body.to, body.subject, body.text || '', options);

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Giviit — Email sender via Gmail (Google Apps Script) — SECOND ACCOUNT
 *
 * Identical mechanism to EmailSender.gs, but deployed under a different
 * Gmail account so it gets its own free ~100 emails/day allowance and a
 * separate "From" address.
 *
 * ── Setup ──
 * 1. Go to https://script.google.com (signed into the SECOND Gmail account)
 *    and create a New Project.
 * 2. Delete the default code and paste this whole file in.
 * 3. Set a secret so randoms can't use this Gmail to send spam:
 *      Project Settings (gear icon, left sidebar) → Script Properties → Add property
 *      Name:  EMAIL_SECRET_2
 *      Value: any long random string (different from the first script's secret)
 * 4. Deploy → New deployment → type: "Web app"
 *      Execute as:        Me (the second Gmail account)
 *      Who has access:    Anyone
 * 5. Click Deploy, authorize the permissions it asks for (it needs Gmail send access).
 * 6. Copy the Web app URL it gives you.
 * 7. Send me that URL + the EMAIL_SECRET_2 value you set in step 3, and tell me
 *    which emails should go through this account (e.g. trust/fraud notices,
 *    admin alerts) — I'll wire them into Backend/.env as
 *    APPS_SCRIPT_EMAIL_URL_2 / APPS_SCRIPT_EMAIL_SECRET_2 and route the
 *    matching email functions in emailService.js through this sender instead
 *    of the default one.
 */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('EMAIL_SECRET_2');

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

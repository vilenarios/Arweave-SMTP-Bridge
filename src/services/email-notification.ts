import { createTransport } from 'nodemailer';
import { config } from '../config/env';
import { createLogger } from '../config/logger';

const logger = createLogger('email-notification');

const transporter = createTransport({
  service: 'gmail',
  auth: {
    user: config.EMAIL_USER,
    pass: config.EMAIL_PASSWORD,
  },
});

export interface UploadedFile {
  fileName: string;
  entityId: string;
  dataTxId?: string;
  fileKey?: string;
}

export interface EmlFileInfo {
  fileName: string;
  entityId: string;
  fileKey?: string;
}

export interface UsageSummary {
  uploadsThisMonth: number;
  freeEmailsUsed: number;
  freeEmailsRemaining: number;
  paidEmailsThisMonth: number;
  costThisMonth: number;
}

/**
 * Send confirmation email after successful upload
 */
export async function sendUploadConfirmation(
  to: string,
  files: UploadedFile[],
  emlFile: EmlFileInfo | null,
  emailSubject: string,
  usage: UsageSummary
): Promise<void> {
  try {
    // Build .eml file section
    const emlSection = emlFile ? `
      <div style="margin-bottom: 30px; border-bottom: 2px solid #e0e0e0; padding-bottom: 20px;">
        <h2 style="margin: 0 0 15px 0; font-size: 18px; color: #333;">📧 Full Email Backup</h2>
        <div style="background-color: #f7f9fc; padding: 15px; border-radius: 8px;">
          <p style="margin: 0 0 10px 0; font-size: 14px;"><strong>${emlFile.fileName}</strong></p>
          <p style="margin: 0; font-size: 13px; font-family: monospace; word-break: break-all;">
            <a href="https://app.ardrive.io/#/file/${emlFile.entityId}/view${emlFile.fileKey ? `?fileKey=${encodeURIComponent(emlFile.fileKey)}` : ''}" target="_blank" style="color: #0066cc;">
              🔗 Download .eml file
            </a>
          </p>
          <p style="margin: 10px 0 0 0; font-size: 12px; color: #666;">
            <em>Import this file into any email client (Gmail, Outlook, Thunderbird, etc.)</em>
          </p>
        </div>
      </div>
    ` : '';

    // Build file list HTML with proper private file sharing links
    const fileListHtml = files.length > 0 ? `
      <div style="margin-bottom: 30px;">
        <h2 style="margin: 0 0 15px 0; font-size: 18px; color: #333;">📎 Attachments (${files.length})</h2>
        ${files.map(file => {
          // For private files, use sharing link with fileKey parameter
          const fileLink = file.fileKey
            ? `https://app.ardrive.io/#/file/${file.entityId}/view?fileKey=${encodeURIComponent(file.fileKey)}`
            : `https://app.ardrive.io/#/file/${file.entityId}/view`;

          return `
            <div style="margin-bottom: 15px; padding: 15px; background-color: #f7f9fc; border-radius: 8px;">
              <p style="margin: 0 0 8px 0; font-size: 14px;"><strong>${file.fileName}</strong></p>
              <p style="margin: 0; font-size: 13px; font-family: monospace; word-break: break-all;">
                <a href="${fileLink}" target="_blank" style="color: #0066cc;">🔗 View/Download</a>
              </p>
            </div>
          `;
        }).join('')}
      </div>
    ` : '';

    // Usage summary
    const usageCostText = usage.costThisMonth > 0
      ? `<p style="margin: 8px 0 0 0;">Cost this month: <strong>$${usage.costThisMonth.toFixed(2)}</strong></p>`
      : '';

    const totalAttachments = files.length;
    const subjectDisplay = emailSubject || 'No Subject';

    const htmlBody = `
      <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #000; font-weight: 300; margin: 0; font-size: 28px;">📬 Email Archived</h1>
          <p style="color: #666; margin-top: 8px; font-size: 16px;">
            "${subjectDisplay}"
          </p>
          ${totalAttachments > 0 ? `<p style="color: #999; margin-top: 4px; font-size: 14px;">${totalAttachments} attachment${totalAttachments > 1 ? 's' : ''}</p>` : ''}
        </div>

        ${emlSection}

        ${fileListHtml}

        <div style="background-color: #f0f0f0; padding: 15px; border-radius: 8px; margin-top: 30px;">
          <p style="margin: 0; font-size: 14px; color: #666;"><strong>Usage This Month:</strong></p>
          <p style="margin: 8px 0 0 0;">Emails: <strong>${usage.uploadsThisMonth}</strong> (${usage.freeEmailsUsed} free, ${usage.paidEmailsThisMonth} paid)</p>
          <p style="margin: 8px 0 0 0;">Free emails remaining: <strong>${usage.freeEmailsRemaining}</strong></p>
          ${usageCostText}
        </div>

        <p style="color: #999; font-size: 13px; text-align: center; margin-top: 30px;">
          Thank you for using ForwARd by ArDrive
        </p>
      </div>
    `;

    // Build text version
    const emlTextSection = emlFile ? `
📧 Full Email Backup:
${emlFile.fileName}
🔗 https://app.ardrive.io/#/file/${emlFile.entityId}/view${emlFile.fileKey ? `?fileKey=${encodeURIComponent(emlFile.fileKey)}` : ''}
Import this file into any email client (Gmail, Outlook, Thunderbird, etc.)

` : '';

    const filesTextSection = files.length > 0 ? `
📎 Attachments (${files.length}):
${files.map(f => {
  const link = f.fileKey
    ? `https://app.ardrive.io/#/file/${f.entityId}/view?fileKey=${encodeURIComponent(f.fileKey)}`
    : `https://app.ardrive.io/#/file/${f.entityId}/view`;
  return `- ${f.fileName}\n  🔗 ${link}`;
}).join('\n')}

` : '';

    const textBody = `
📬 Email Archived: "${subjectDisplay}"

${emlTextSection}${filesTextSection}
Usage this month:
- Total emails: ${usage.uploadsThisMonth}
- Free: ${usage.freeEmailsUsed}
- Paid: ${usage.paidEmailsThisMonth}
- Free remaining: ${usage.freeEmailsRemaining}
${usage.costThisMonth > 0 ? `- Cost: $${usage.costThisMonth.toFixed(2)}` : ''}

---
ForwARd by ArDrive
    `.trim();

    await transporter.sendMail({
      from: config.EMAIL_USER,
      to,
      subject: `Email archived: "${subjectDisplay}"${totalAttachments > 0 ? ` (${totalAttachments} attachment${totalAttachments > 1 ? 's' : ''})` : ''}`,
      text: textBody,
      html: htmlBody,
    });

    logger.info({ to, fileCount: files.length, hasEml: !!emlFile }, 'Confirmation email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send confirmation email');
    throw error;
  }
}

/**
 * Send welcome email when drive is created
 */
export async function sendDriveWelcomeEmail(
  to: string,
  driveId: string,
  driveKeyBase64: string,
  userEmail: string
): Promise<void> {
  try {
    const driveLink = `https://app.ardrive.io/#/drives/${driveId}?driveKey=${encodeURIComponent(driveKeyBase64)}`;

    const htmlBody = `
      <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #000; font-weight: 300; margin: 0; font-size: 28px;">🎉 Your Private Drive is Ready!</h1>
          <p style="color: #666; margin-top: 8px; font-size: 16px;">
            Welcome to ForwARd - Your Personal Email Archive
          </p>
        </div>

        <div style="background-color: #f7f9fc; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
          <p style="margin: 0 0 15px 0; font-size: 16px;">
            <strong>Your Private Drive:</strong> ${userEmail}
          </p>
          <p style="margin: 0 0 15px 0; font-size: 14px; color: #666;">
            All your emails and attachments will be archived in this encrypted, permanent storage drive on Arweave.
          </p>
          <div style="text-align: center; margin: 20px 0;">
            <a href="${driveLink}" style="background-color: #000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: 500;">
              🔗 Open Your Drive
            </a>
          </div>
        </div>

        <div style="background-color: #fff9f9; padding: 20px; border-radius: 8px; border-left: 4px solid #e74c3c; margin-bottom: 30px;">
          <p style="margin: 0 0 10px 0; font-size: 14px;"><strong>⚠️ Important Security Notice:</strong></p>
          <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #666;">
            <li>This link contains your drive key - keep it secure!</li>
            <li>Anyone with this link can access your entire email archive</li>
            <li>Save it in a password manager or secure location</li>
            <li>Future emails will contain individual file links (not the master drive key)</li>
          </ul>
        </div>

        <div style="background-color: #f0f0f0; padding: 15px; border-radius: 8px;">
          <p style="margin: 0 0 10px 0; font-size: 14px;"><strong>How It Works:</strong></p>
          <ul style="margin: 0; padding-left: 20px; font-size: 14px; color: #666;">
            <li>Send emails with attachments to ${config.EMAIL_USER}</li>
            <li>Your emails are organized by date in folders (Year/Month/Email)</li>
            <li>Each email is saved as .eml file (importable to any email client)</li>
            <li>Get 10 free emails per month, then $0.10 per email</li>
          </ul>
        </div>

        <p style="color: #999; font-size: 13px; text-align: center; margin-top: 30px;">
          Thank you for using ForwARd by ArDrive
        </p>
      </div>
    `;

    const textBody = `
🎉 Your Private Drive is Ready!

Welcome to ForwARd - Your Personal Email Archive

Your Private Drive: ${userEmail}
All your emails and attachments will be archived in this encrypted, permanent storage drive on Arweave.

🔗 Open Your Drive: ${driveLink}

⚠️ IMPORTANT SECURITY NOTICE:
- This link contains your drive key - keep it secure!
- Anyone with this link can access your entire email archive
- Save it in a password manager or secure location
- Future emails will contain individual file links (not the master drive key)

How It Works:
- Send emails with attachments to ${config.EMAIL_USER}
- Your emails are organized by date in folders (Year/Month/Email)
- Each email is saved as .eml file (importable to any email client)
- Get 10 free emails per month, then $0.10 per email

---
ForwARd by ArDrive
    `.trim();

    await transporter.sendMail({
      from: config.EMAIL_USER,
      to,
      subject: '🎉 Your ForwARd Private Drive is Ready!',
      text: textBody,
      html: htmlBody,
    });

    logger.info({ to, driveId }, 'Welcome email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send welcome email');
    throw error;
  }
}

/**
 * Send usage limit notification
 */
export async function sendUsageLimitEmail(
  to: string,
  reason: string,
  usage: UsageSummary
): Promise<void> {
  try {
    const htmlBody = `
      <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #000; font-weight: 300; margin: 0; font-size: 28px;">Upload Limit Reached</h1>
          <p style="color: #666; margin-top: 8px; font-size: 16px;">Your free tier limit has been reached</p>
        </div>

        <div style="background-color: #fff9f9; padding: 20px; border-radius: 8px; border-left: 4px solid #e74c3c; margin-bottom: 30px;">
          <p style="margin: 0; font-size: 16px;">${reason}</p>
        </div>

        <div style="background-color: #f0f0f0; padding: 15px; border-radius: 8px;">
          <p style="margin: 0; font-size: 14px; color: #666;"><strong>Usage This Month:</strong></p>
          <p style="margin: 8px 0 0 0;">Emails: <strong>${usage.uploadsThisMonth}</strong></p>
          <p style="margin: 8px 0 0 0;">Free: ${usage.freeEmailsUsed} / ${config.FREE_EMAILS_PER_MONTH}</p>
          <p style="margin: 8px 0 0 0;">Paid: ${usage.paidEmailsThisMonth}</p>
          ${usage.costThisMonth > 0 ? `<p style="margin: 8px 0 0 0;">Cost: $${usage.costThisMonth.toFixed(2)}</p>` : ''}
        </div>

        <p style="color: #999; font-size: 13px; text-align: center; margin-top: 30px;">
          ForwARd by ArDrive
        </p>
      </div>
    `;

    const textBody = `
Upload Limit Reached

${reason}

Usage this month:
- Total emails: ${usage.uploadsThisMonth}
- Free: ${usage.freeEmailsUsed} / ${config.FREE_EMAILS_PER_MONTH}
- Paid: ${usage.paidEmailsThisMonth}
${usage.costThisMonth > 0 ? `- Cost: $${usage.costThisMonth.toFixed(2)}` : ''}

---
ForwARd by ArDrive
    `.trim();

    await transporter.sendMail({
      from: config.EMAIL_USER,
      to,
      subject: 'Upload Limit Reached - ForwARd',
      text: textBody,
      html: htmlBody,
    });

    logger.info({ to }, 'Usage limit email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send usage limit email');
  }
}

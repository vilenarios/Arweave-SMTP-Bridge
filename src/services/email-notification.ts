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
  driveId: string,
  usage: UsageSummary
): Promise<void> {
  try {
    const driveLink = `https://ardrive.net/#/drives/${driveId}`;

    // Build file list HTML
    const fileListHtml = files.map(file => {
      const previewLink = file.dataTxId
        ? `https://ardrive.net/${file.dataTxId}`
        : `https://ardrive.net/#/file/${file.entityId}/view`;

      return `
        <div style="margin-bottom: 20px; padding: 15px; background-color: #f7f9fc; border-radius: 8px;">
          <p style="margin: 0; font-size: 16px;"><strong>${file.fileName}</strong></p>
          <p style="margin: 8px 0 0 0; font-size: 14px; font-family: monospace;">
            <a href="${previewLink}" target="_blank">${previewLink}</a>
          </p>
          ${file.fileKey ? `
            <p style="margin: 8px 0 0 0; font-size: 12px; color: #b00;">
              <strong>File Key:</strong> ${file.fileKey}<br/>
              <em>Save this key - required to decrypt this file</em>
            </p>
          ` : ''}
        </div>
      `;
    }).join('');

    // Usage summary
    const usageCostText = usage.costThisMonth > 0
      ? `<p style="margin: 8px 0 0 0;">Cost this month: <strong>$${usage.costThisMonth.toFixed(2)}</strong></p>`
      : '';

    const htmlBody = `
      <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #000; font-weight: 300; margin: 0; font-size: 28px;">Upload Successful</h1>
          <p style="color: #666; margin-top: 8px; font-size: 16px;">
            ${files.length} file${files.length > 1 ? 's' : ''} uploaded to your private ArDrive
          </p>
        </div>

        <div style="margin-bottom: 30px;">
          ${fileListHtml}
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${driveLink}" style="background-color: #000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: 500;">
            View Your Drive
          </a>
        </div>

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

    const textBody = `
Your files were successfully uploaded to ArDrive!

Files (${files.length}):
${files.map(f => `- ${f.fileName}\n  Preview: https://ardrive.net/#/file/${f.entityId}/view${f.fileKey ? `\n  File Key: ${f.fileKey}` : ''}`).join('\n')}

View your drive: ${driveLink}

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
      subject: `${files.length} file${files.length > 1 ? 's' : ''} uploaded to ArDrive`,
      text: textBody,
      html: htmlBody,
    });

    logger.info({ to, fileCount: files.length }, 'Confirmation email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send confirmation email');
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

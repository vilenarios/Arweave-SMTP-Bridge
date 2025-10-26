import { createTransport, Transporter } from 'nodemailer';
import { config } from '../config/env';
import { createLogger } from '../config/logger';
import { oauth2Service } from './oauth2-service';

const logger = createLogger('email-notification');

/**
 * Create SMTP transporter with appropriate authentication
 * Uses OAuth2 if configured, otherwise falls back to password
 */
async function getTransporter(): Promise<Transporter> {
  let authConfig: any;

  if (oauth2Service.isOAuth2Configured()) {
    logger.debug('Creating SMTP transporter with OAuth2');
    const accessToken = await oauth2Service.getAccessToken();
    authConfig = {
      type: 'OAuth2',
      user: config.EMAIL_USER,
      accessToken,
    };
  } else {
    logger.debug('Creating SMTP transporter with password');
    authConfig = {
      user: config.EMAIL_USER,
      pass: config.EMAIL_PASSWORD,
    };
  }

  return createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false, // Use STARTTLS
    auth: authConfig,
    tls: {
      rejectUnauthorized: true
    }
  });
}

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
 * Base email template with ArDrive branding and dark mode support
 * Meets WCAG AA accessibility standards
 */
function getEmailTemplate(content: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <style>
    /* Client-specific styles */
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }

    /* Dark mode support */
    @media (prefers-color-scheme: dark) {
      .email-container { background-color: #0A0B09 !important; }
      .email-body { background-color: #0A0B09 !important; color: #FFFFFF !important; }
      .text-primary { color: #FFFFFF !important; }
      .text-secondary { color: #CECECE !important; }
      .bg-light { background-color: #1A1B19 !important; }
      .bg-section { background-color: #1A1B19 !important; border-color: #344955 !important; }
      .bg-warning { background-color: #4D080C !important; border-color: #FE0230 !important; }
      .bg-info { background-color: #1A1B19 !important; border-color: #344955 !important; }
      .border-grey { border-color: #344955 !important; }
      .link { color: #FE0230 !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #F7F7F7;" class="email-body">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #F7F7F7;" class="email-container">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; background-color: #FFFFFF; border-radius: 8px;" class="bg-light">
          <tr>
            <td style="padding: 40px 30px;">
              ${content}

              <!-- Footer -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #EBEBEB;" class="border-grey">
                <tr>
                  <td align="center">
                    <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #666666;" class="text-secondary">
                      ForwARd by <strong style="color: #FE0230;">ArDrive</strong>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Send confirmation email after successful upload
 */
export async function sendUploadConfirmation(
  to: string,
  emlFile: EmlFileInfo,
  emailSubject: string,
  usage: UsageSummary,
  driveType: 'private' | 'public' = 'private'
): Promise<void> {
  try {
    const subjectDisplay = emailSubject || 'No Subject';

    // Build file URL based on drive type
    const fileUrl = driveType === 'private'
      ? `https://app.ardrive.io/#/file/${emlFile.entityId}/view?fileKey=${emlFile.fileKey}`
      : `https://app.ardrive.io/#/file/${emlFile.entityId}/view`;

    // Public drive warning
    const publicWarning = driveType === 'public'
      ? `<tr><td style="padding: 12px; background-color: #FFF3CD; border: 1px solid #FFE69C; border-radius: 6px; margin-bottom: 16px;"><p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #856404;"><strong>⚠️ PUBLIC FILE:</strong> This file is publicly viewable by anyone with the link.</p></td></tr>`
      : '';

    // Usage cost text
    const usageCostHtml = usage.costThisMonth > 0
      ? `<tr><td style="padding: 4px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary"><strong>Cost this month:</strong> $${usage.costThisMonth.toFixed(2)}</td></tr>`
      : '';

    const content = `
      <!-- Header -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 30px;">
        <tr>
          <td>
            <h1 style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 600; line-height: 1.3; color: rgba(0,0,0,0.87);" class="text-primary">
              Email Archived Successfully
            </h1>
            <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #666666;" class="text-secondary">
              "${subjectDisplay}"
            </p>
          </td>
        </tr>
      </table>

      <!-- Public Drive Warning -->
      ${publicWarning}

      <!-- Email Archive Section -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 24px;">
        <tr>
          <td>
            <h2 style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 16px; font-weight: 600; line-height: 1.3; color: rgba(0,0,0,0.87);" class="text-primary">
              Complete Email Archive
            </h2>
          </td>
        </tr>
        <tr>
          <td style="padding: 16px; background-color: #F7F7F7; border-radius: 6px; border-left: 3px solid #FE0230;" class="bg-section">
            <p style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
              ${emlFile.fileName}
            </p>
            <p style="margin: 0 0 12px 0;">
              <a href="https://app.ardrive.io/#/file/${emlFile.entityId}/view${emlFile.fileKey ? `?fileKey=${emlFile.fileKey}` : ''}"
                 style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 500; line-height: 1.5; color: #D31721; text-decoration: underline;"
                 class="link">
                Download Email Archive (.eml)
              </a>
            </p>
            <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; color: #666666;" class="text-secondary">
              This .eml file contains your complete email including all attachments. Import it into any email client (Gmail, Outlook, Thunderbird, etc.) to access everything.
            </p>
          </td>
        </tr>
      </table>

      <!-- Usage Summary -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding: 16px; background-color: #F7F7F7; border-radius: 6px;" class="bg-section">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  Usage This Month
                </td>
              </tr>
              <tr>
                <td style="padding: 4px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  <strong>Emails:</strong> ${usage.uploadsThisMonth} (${usage.freeEmailsUsed} free, ${usage.paidEmailsThisMonth} paid)
                </td>
              </tr>
              <tr>
                <td style="padding: 4px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  <strong>Free emails remaining:</strong> ${usage.freeEmailsRemaining}
                </td>
              </tr>
              ${usageCostHtml}
            </table>
          </td>
        </tr>
      </table>
    `;

    const htmlBody = getEmailTemplate(content);

    const textBody = `
Email Archived Successfully

"${subjectDisplay}"

${driveType === 'public' ? '⚠️ PUBLIC FILE: This file is publicly viewable by anyone with the link.\n\n' : ''}Complete Email Archive:
${emlFile.fileName}

Download: https://app.ardrive.io/#/file/${emlFile.entityId}/view${emlFile.fileKey ? `?fileKey=${emlFile.fileKey}` : ''}

This .eml file contains your complete email including all attachments.
Import it into any email client (Gmail, Outlook, Thunderbird, etc.) to access everything.

Usage this month:
- Total emails: ${usage.uploadsThisMonth}
- Free: ${usage.freeEmailsUsed}
- Paid: ${usage.paidEmailsThisMonth}
- Free remaining: ${usage.freeEmailsRemaining}
${usage.costThisMonth > 0 ? `- Cost: $${usage.costThisMonth.toFixed(2)}` : ''}

---
ForwARd by ArDrive
    `.trim();

    const transporter = await getTransporter();
    await transporter.sendMail({
      from: `ForwARd <${config.EMAIL_USER}>`,
      to,
      replyTo: config.EMAIL_USER,
      subject: `Email archived: "${subjectDisplay}"`,
      text: textBody,
      html: htmlBody,
      headers: {
        'X-Mailer': 'ForwARd by ArDrive',
        'X-Priority': '3',
        'Importance': 'normal',
        'List-Unsubscribe': `<mailto:${config.EMAIL_USER}?subject=unsubscribe>`,
        'Precedence': 'bulk'
      }
    });

    logger.info({ to }, 'Confirmation email sent');
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
  driveType: 'private' | 'public',
  driveKeyBase64: string | undefined,
  userEmail: string,
  walletAddress?: string
): Promise<void> {
  try {
    // Drive link with name parameter (ArDrive keys are already base64url encoded, don't encode again)
    const driveName = encodeURIComponent(userEmail);
    const driveLink = driveType === 'private' && driveKeyBase64
      ? `https://app.ardrive.io/#/drives/${driveId}?name=${driveName}&driveKey=${driveKeyBase64}`
      : `https://app.ardrive.io/#/drives/${driveId}?name=${driveName}`;

    // Drive type labels
    const driveTypeLabel = driveType === 'private' ? 'Private' : 'Public';
    const driveTypeDescription = driveType === 'private'
      ? 'encrypted, permanent storage'
      : 'public, permanent storage';

    // Public warning banner (shown for public drives)
    const publicWarningHtml = driveType === 'public' ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 24px;">
        <tr>
          <td style="padding: 16px; background-color: #FFF3CD; border-radius: 6px; border-left: 3px solid #FFE69C;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.5; color: #856404;">
                  ⚠️ Public Drive Warning
                </td>
              </tr>
              <tr>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #856404;">
                  This is a PUBLIC drive. All files uploaded here are publicly viewable by anyone. Do not upload sensitive or private information.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    ` : '';

    // Security warning (only shown for private drives)
    const securityWarningHtml = driveType === 'private' ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 24px;">
        <tr>
          <td style="padding: 16px; background-color: #FCF9FA; border-radius: 6px; border-left: 3px solid #C0151E;" class="bg-warning">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  Important Security Notice
                </td>
              </tr>
              <tr>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #666666;" class="text-secondary">
                  • This link contains your drive key - keep it secure<br>
                  • Anyone with this link can access your entire email archive<br>
                  • Save it in a password manager or secure location<br>
                  • Future emails will contain individual file links (not the master drive key)
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    ` : '';

    // Wallet address section (only show in multi-wallet mode)
    const walletHtml = walletAddress ? `
      <tr>
        <td style="padding: 4px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #666666; font-family: 'Courier New', monospace;" class="text-secondary">
          <strong>Wallet Address:</strong> ${walletAddress}
        </td>
      </tr>
    ` : '';

    const content = `
      <!-- Header -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 30px;">
        <tr>
          <td>
            <h1 style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 600; line-height: 1.3; color: rgba(0,0,0,0.87);" class="text-primary">
              Your ${driveTypeLabel} Drive is Ready
            </h1>
            <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #666666;" class="text-secondary">
              Welcome to ForwARd - Your ${driveTypeLabel} Email Archive
            </p>
          </td>
        </tr>
      </table>

      <!-- Public Drive Warning -->
      ${publicWarningHtml}

      <!-- Drive Details -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 24px;">
        <tr>
          <td style="padding: 20px; background-color: #F7F7F7; border-radius: 6px; border-left: 3px solid #FE0230;" class="bg-section">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  Your ${driveTypeLabel} Drive: ${userEmail}
                </td>
              </tr>
              <tr>
                <td style="padding: 4px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #666666; font-family: 'Courier New', monospace;" class="text-secondary">
                  <strong>Drive ID:</strong> ${driveId}
                </td>
              </tr>
              ${walletHtml}
              <tr>
                <td style="padding: 16px 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #666666;" class="text-secondary">
                  All your emails and attachments will be archived in this ${driveTypeDescription} drive on Arweave.
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-top: 8px;">
                  <a href="${driveLink}"
                     style="display: inline-block; padding: 12px 32px; background-color: #FE0230; color: #FFFFFF; text-decoration: none; border-radius: 4px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; line-height: 1.5;">
                    Open Your Drive
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Indexing Notice -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 20px;">
        <tr>
          <td style="padding: 16px; background-color: #FCF9FA; border-radius: 6px; border-left: 3px solid #FE0230;" class="bg-info">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  Indexing Delay
                </td>
              </tr>
              <tr>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #666666;" class="text-secondary">
                  New files may take up to 10 minutes to appear in ArDrive after upload. This is normal behavior for the Arweave network's indexing process.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>

      <!-- Security Warning (Private drives only) -->
      ${securityWarningHtml}

      <!-- How It Works -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding: 16px; background-color: #F7F7F7; border-radius: 6px;" class="bg-section">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  How It Works
                </td>
              </tr>
              <tr>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #666666;" class="text-secondary">
                  • Send emails to <strong>${driveType === 'public' ? 'public-preserve@ardrive.io' : 'preserve@ardrive.io or private-preserve@ardrive.io'}</strong><br>
                  • Organized by date (Year/Month), saved as .eml files<br>
                  • 10 free emails/month, then $0.10/email
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;

    const htmlBody = getEmailTemplate(content);

    const textBody = `
Your ${driveTypeLabel} Drive is Ready

Welcome to ForwARd - Your ${driveTypeLabel} Email Archive

${driveType === 'public' ? '⚠️ PUBLIC DRIVE WARNING:\nThis is a PUBLIC drive. All files uploaded here are publicly viewable by anyone. Do not upload sensitive or private information.\n\n' : ''}Your ${driveTypeLabel} Drive: ${userEmail}
Drive ID: ${driveId}
${walletAddress ? `Wallet Address: ${walletAddress}` : ''}

All your emails and attachments will be archived in this ${driveTypeDescription} drive on Arweave.

Open Your Drive: ${driveLink}

INDEXING DELAY:
New files may take up to 10 minutes to appear in ArDrive after upload. This is normal behavior for the Arweave network's indexing process.

${driveType === 'private' ? `IMPORTANT SECURITY NOTICE:
- This link contains your drive key - keep it secure!
- Anyone with this link can access your entire email archive
- Save it in a password manager or secure location
- Future emails will contain individual file links (not the master drive key)

` : ''}How It Works:
- Send emails to ${driveType === 'public' ? 'public-preserve@ardrive.io' : 'preserve@ardrive.io or private-preserve@ardrive.io'}
- Organized by date (Year/Month), saved as .eml files
- 10 free emails/month, then $0.10/email

---
ForwARd by ArDrive
    `.trim();

    const transporter = await getTransporter();
    await transporter.sendMail({
      from: config.EMAIL_USER,
      to,
      subject: `Your ForwARd ${driveTypeLabel} Drive is Ready`,
      text: textBody,
      html: htmlBody,
    });

    logger.info({ to, driveId, driveType }, 'Welcome email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send welcome email');
    throw error;
  }
}

/**
 * Send error notification when upload fails unrecoverably
 */
export async function sendUploadErrorEmail(
  to: string,
  subject: string | undefined,
  errorMessage: string,
  retryCount: number
): Promise<void> {
  try {
    const subjectDisplay = subject || 'No Subject';

    const content = `
      <!-- Header -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 30px;">
        <tr>
          <td>
            <h1 style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 600; line-height: 1.3; color: #C0151E;">
              Email Archive Failed
            </h1>
            <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #666666;" class="text-secondary">
              Unable to archive your email
            </p>
          </td>
        </tr>
      </table>

      <!-- Error Details -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 20px;">
        <tr>
          <td style="padding: 16px; background-color: #FCF9FA; border-radius: 6px; border-left: 3px solid #C0151E;" class="bg-warning">
            <p style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
              Email: "${subjectDisplay}"
            </p>
            <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #666666;" class="text-secondary">
              We attempted to upload your email ${retryCount} time${retryCount > 1 ? 's' : ''} but encountered an error.
            </p>
          </td>
        </tr>
      </table>

      <!-- Technical Error -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 24px;">
        <tr>
          <td style="padding: 16px; background-color: #F7F7F7; border-radius: 6px;" class="bg-section">
            <p style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
              Error Details
            </p>
            <p style="margin: 0; font-family: 'Courier New', monospace; font-size: 13px; line-height: 1.5; color: #C0151E; word-break: break-word;">
              ${errorMessage}
            </p>
          </td>
        </tr>
      </table>

      <!-- Next Steps -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding: 16px; background-color: #F7F7F7; border-radius: 6px;" class="bg-section">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  What to do
                </td>
              </tr>
              <tr>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #666666;" class="text-secondary">
                  • Try sending your email again<br>
                  • If you have large attachments, try splitting them into separate emails<br>
                  • Check that your email size is under 1GB<br>
                  • If the problem persists, contact support
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;

    const htmlBody = getEmailTemplate(content);

    const textBody = `
Email Archive Failed

Email: "${subjectDisplay}"
We attempted to upload your email ${retryCount} time${retryCount > 1 ? 's' : ''} but encountered an error.

Error Details:
${errorMessage}

What to do:
- Try sending your email again
- If you have large attachments, try splitting them into separate emails
- Check that your email size is under 1GB
- If the problem persists, contact support

---
ForwARd by ArDrive
    `.trim();

    const transporter = await getTransporter();
    await transporter.sendMail({
      from: config.EMAIL_USER,
      to,
      subject: `Email archive failed: "${subjectDisplay}"`,
      text: textBody,
      html: htmlBody,
    });

    logger.info({ to }, 'Error notification email sent');
  } catch (error) {
    logger.error({ error, to }, 'Failed to send error notification email');
    // Don't throw - we don't want to fail the error handler
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
    const usageCostHtml = usage.costThisMonth > 0
      ? `<tr><td style="padding: 4px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary"><strong>Cost:</strong> $${usage.costThisMonth.toFixed(2)}</td></tr>`
      : '';

    const content = `
      <!-- Header -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 30px;">
        <tr>
          <td>
            <h1 style="margin: 0 0 8px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 600; line-height: 1.3; color: rgba(0,0,0,0.87);" class="text-primary">
              Upload Limit Reached
            </h1>
            <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #666666;" class="text-secondary">
              Your free tier limit has been reached
            </p>
          </td>
        </tr>
      </table>

      <!-- Reason -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 24px;">
        <tr>
          <td style="padding: 16px; background-color: #FCF9FA; border-radius: 6px; border-left: 3px solid #C0151E;" class="bg-warning">
            <p style="margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
              ${reason}
            </p>
          </td>
        </tr>
      </table>

      <!-- Usage Summary -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding: 16px; background-color: #F7F7F7; border-radius: 6px;" class="bg-section">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-bottom: 8px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  Usage This Month
                </td>
              </tr>
              <tr>
                <td style="padding: 4px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  <strong>Emails:</strong> ${usage.uploadsThisMonth}
                </td>
              </tr>
              <tr>
                <td style="padding: 4px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  <strong>Free:</strong> ${usage.freeEmailsUsed} / ${config.FREE_EMAILS_PER_MONTH}
                </td>
              </tr>
              <tr>
                <td style="padding: 4px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color: rgba(0,0,0,0.87);" class="text-primary">
                  <strong>Paid:</strong> ${usage.paidEmailsThisMonth}
                </td>
              </tr>
              ${usageCostHtml}
            </table>
          </td>
        </tr>
      </table>
    `;

    const htmlBody = getEmailTemplate(content);

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

    const transporter = await getTransporter();
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

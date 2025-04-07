import * as QRCode from 'qrcode';
import { createTransport } from 'nodemailer';
import { UploadedFileInfo } from './email-upload';

const smtpTransport = createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASSWORD || ''
  }
});

export async function sendConfirmationEmail(
  to: string,
  files: UploadedFileInfo[],
  uploadType: 'turbo' | 'arweave-js' | 'ardrive'
) {
  try {
    const uploadTypeName =
      uploadType === 'ardrive'
        ? 'ArDrive'
        : uploadType === 'turbo'
        ? 'ArDrive Turbo'
        : 'Arweave.js';

    const textLines: string[] = [
      `Your file${files.length > 1 ? 's were' : ' was'} successfully uploaded using ${uploadTypeName}!`,
      ''
    ];
    const htmlBlocks: string[] = [];

    for (const file of files) {
      const previewLink = `https://arweave.net/${file.dataTxId ?? file.id}`;
      const shareLink = `https://ardrive.net/#/file/${file.id}/view`;
      const qrCode = await QRCode.toDataURL(shareLink);

      // Plaintext fallback
      textLines.push(`File: ${file.fileName}`);
      textLines.push(`Direct Preview: ${previewLink}`);
      if (uploadType === 'ardrive') {
        textLines.push(`Sharing Link: ${shareLink}`);
      }
      if (file.fileKey) textLines.push(`Private File Key: ${file.fileKey}`);
      textLines.push('');

      // HTML block
      htmlBlocks.push(`
        <div style="margin-bottom: 30px;">
          <p style="font-size: 16px;"><strong>File:</strong> ${file.fileName}</p>
          
          <div style="background-color: #f7f9fc; padding: 15px; border-radius: 8px; font-family: monospace;">
            <p style="margin: 0;"><strong>Direct Preview:</strong> <a href="${previewLink}" target="_blank">${previewLink}</a></p>
            ${uploadType === 'ardrive' ? `<p style="margin: 8px 0 0 0;"><strong>Sharing Link:</strong> <a href="${shareLink}" target="_blank">${shareLink}</a></p>` : ''}
            <p style="margin: 8px 0 0 0; color: #666;"><strong>Method:</strong> ${uploadTypeName}</p>
            ${
              file.fileKey
                ? `<p style="margin: 8px 0 0 0; color: #b00;"><strong>Private File Key:</strong> ${file.fileKey}</p>`
                : ''
            }
          </div>

          <div style="text-align: center; margin-top: 15px;">
            <img src="${qrCode}" alt="QR Code for ${file.fileName}" style="width: 160px; height: 160px;" />
            <p style="color: #666; font-size: 13px;">Scan to open sharing link</p>
          </div>

          <div style="text-align: center; margin-top: 15px;">
            <a href="${previewLink}" style="background-color: #000; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: 500;">Open File</a>
          </div>
        </div>
      `);
    }

    const htmlBody = `
      <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #000; font-weight: 300; margin: 0; font-size: 28px;">Upload Successful</h1>
          <p style="color: #666; margin-top: 8px; font-size: 16px;">Your file${files.length > 1 ? 's have' : ' has'} been stored using ${uploadTypeName}</p>
        </div>

        ${htmlBlocks.join('')}

        <p style="color: #999; font-size: 13px; text-align: center; margin-top: 25px;">Thank you for using ForwARd by ArDrive</p>
      </div>
    `;

    await smtpTransport.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject: `${uploadTypeName} Upload Confirmation (${files.length} file${files.length > 1 ? 's' : ''})`,
      text: textLines.join('\n'),
      html: htmlBody
    });

    console.log(`✅ Confirmation email sent to ${to}`);
  } catch (error) {
    console.error('❌ Error sending confirmation email:', error);
  }
}
  
export async function sendErrorEmail(to: string, fileName: string, error: any) {
    try {
      await smtpTransport.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject: `Upload Failed: ${fileName}`,
        text: `There was an error processing your file "${fileName}".\n\nError: ${error?.message || 'Unknown error'}\n\nPlease try again or contact support if the issue persists.`,
        html: `
          <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #000; font-weight: 300; margin: 0; font-size: 28px;">Upload Failed</h1>
              <p style="color: #666; margin-top: 8px; font-size: 16px;">We encountered an issue with your file</p>
            </div>
            
            <div style="background-color: #fff; border-radius: 8px; padding: 25px; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
              <p style="font-size: 16px; margin-bottom: 20px;">There was an error processing your file <strong>${fileName}</strong>.</p>
              
              <div style="background-color: #fff9f9; padding: 15px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #e74c3c;">
                <p style="margin: 0; font-size: 14px;"><strong>Error:</strong> ${error?.message || 'Unknown error'}</p>
              </div>
              
              <p style="font-size: 16px; color: #666;">Please try again or contact support if the issue persists.</p>
            </div>
            
            <p style="color: #999; font-size: 13px; text-align: center; margin-top: 25px;">Thank you for using Arweave SMTP Bridge.</p>
          </div>
        `
      });
      console.log(`Error email sent to ${to}`);
    } catch (error) {
      console.error('Error sending error email:', error);
    }
  }
  
export async function sendSizeExceededEmail(to: string, fileName: string) {
    try {
      await smtpTransport.sendMail({
        from: process.env.EMAIL_USER,
        to,
        subject: `File Size Exceeded: ${fileName}`,
        text: `Your file "${fileName}" exceeds the 100MB free tier limit for Arweave uploads.\n\nPlease try uploading a smaller file.`,
        html: `
          <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #000; font-weight: 300; margin: 0; font-size: 28px;">File Size Exceeded</h1>
              <p style="color: #666; margin-top: 8px; font-size: 16px;">Your file is too large for the free tier</p>
            </div>
            
            <div style="background-color: #fff; border-radius: 8px; padding: 25px; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
              <p style="font-size: 16px; margin-bottom: 20px;">Your file <strong>${fileName}</strong> exceeds the 100MB free tier limit for Arweave uploads.</p>
              
              <div style="background-color: #fffcf5; padding: 15px; border-radius: 8px; margin: 15px 0; border-left: 4px solid #f39c12;">
                <p style="margin: 0; font-size: 14px;"><strong>Limit:</strong> 100MB for free tier uploads</p>
              </div>
              
              <p style="font-size: 16px; color: #666;">Please try uploading a smaller file.</p>
            </div>
            
            <p style="color: #999; font-size: 13px; text-align: center; margin-top: 25px;">Thank you for using Arweave SMTP Bridge.</p>
          </div>
        `
      });
      console.log(`Size exceeded email sent to ${to}`);
    } catch (error) {
      console.error('Error sending size exceeded email:', error);
    }
  } 
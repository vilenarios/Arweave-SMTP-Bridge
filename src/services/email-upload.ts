import { createTransport } from 'nodemailer';
import { simpleParser } from 'mailparser';
import Imap from 'imap';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as QRCode from 'qrcode';
import { retryUpload, AttachmentInfo, loadArweaveJWK } from './arweave-upload';

// Configure email connection
const imap = new Imap({
  user: process.env.EMAIL_USER || '',
  password: process.env.EMAIL_PASSWORD || '',
  host: 'imap.gmail.com',
  port: 993,
  tls: true
});

const smtpTransport = createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASSWORD || ''
  }
});

// Process incoming emails
export async function handleIncomingEmails() {
  console.log('Starting to monitor inbox for new emails...');
  
  imap.once('ready', () => {
    console.log('IMAP connection ready');
    imap.openBox('INBOX', false, (err) => {
      if (err) {
        console.error('Error opening inbox:', err);
        return;
      }
      console.log('INBOX opened, waiting for new emails');
      imap.on('mail', processMessages);
    });
  });

  imap.once('error', (err: Error) => {
    console.error('IMAP connection error:', err);
  });

  imap.once('end', () => {
    console.log('IMAP connection ended');
  });

  imap.connect();
}

async function processMessages() {
  console.log('New messages detected, processing...');
  const MAX_EMAILS_TO_PROCESS = 10; // Reasonable limit
  
  // Define the required keyword for subject filtering
  const REQUIRED_SUBJECT_KEYWORD = 'arweave';
  console.log(`Filtering emails with subject containing: "${REQUIRED_SUBJECT_KEYWORD}"`);
  
  const searchCriteria = ['UNSEEN', ['SINCE', new Date(Date.now() - 24*60*60*1000).toISOString()]];
  const fetchOptions = { bodies: '', markSeen: true };
  
  imap.search(searchCriteria, (err, results) => {
    if (err) {
      console.error('Error searching emails:', err);
      return;
    }
    
    if (results.length === 0) {
      console.log('No new messages found');
      return;
    }
    
    const messagesToProcess = results.slice(0, MAX_EMAILS_TO_PROCESS);
    console.log(`Found ${results.length} new messages, processing up to ${messagesToProcess.length}`);
    
    const fetch = imap.fetch(messagesToProcess, fetchOptions);
    
    fetch.on('message', (msg) => {
      let emailBuffer = '';
      
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => {
          emailBuffer += chunk.toString();
        });
        
        stream.on('end', async () => {
          try {
            const parsed = await simpleParser(emailBuffer);
            const sender = parsed.from?.value[0].address;
            const subject = parsed.subject || '';
            
            console.log(`Processing email from: ${sender}, Subject: "${subject}"`);
            
            // Check if subject contains the required keyword (case insensitive)
            if (!subject.toLowerCase().includes(REQUIRED_SUBJECT_KEYWORD.toLowerCase())) {
              console.log(`Skipping email: Subject does not contain "${REQUIRED_SUBJECT_KEYWORD}"`);
              return;
            }
            
            console.log(`Subject contains "${REQUIRED_SUBJECT_KEYWORD}", continuing with processing`);
            
            if (parsed.attachments && parsed.attachments.length > 0) {
              console.log(`Found ${parsed.attachments.length} attachments`);
              
              for (const attachment of parsed.attachments) {
                console.log(`Processing attachment: ${attachment.filename}, size: ${attachment.size} bytes`);
                
                // 100MB free tier limit (assuming this is the free tier limit)
                if (attachment.size <= 100 * 1024 * 1024) {
                  try {
                    console.log(`Preparing to upload ${attachment.filename} to Arweave...`);
                    
                    // Convert attachment to our defined interface
                    const attachmentInfo: AttachmentInfo = {
                      filename: attachment.filename,
                      content: attachment.content,
                      size: attachment.size,
                      contentType: attachment.contentType
                    };
                    
                    const result = await retryUpload(attachmentInfo);
                    
                    console.log(`Upload successful! Transaction ID: ${result.id}, Type: ${result.type}`);
                    
                    if (sender) {
                      await sendConfirmationEmail(sender, result.id, result.type, attachment.filename || 'file');
                    }
                  } catch (error) {
                    console.error('Upload failed:', error);
                    let errorMsg = '';
                    
                    if (error instanceof Error) {
                      errorMsg = error.message;
                      // Check for specific error types
                      if (errorMsg.includes('ECONNRESET')) {
                        errorMsg = 'Connection to Arweave network was reset. This may be due to network issues or service unavailability.';
                      } else if (errorMsg.includes('timeout')) {
                        errorMsg = 'Connection to Arweave timed out. The service may be experiencing high load.';
                      } else if (errorMsg.toLowerCase().includes('insufficient funds')) {
                        errorMsg = 'Insufficient funds in Arweave wallet to complete this upload.';
                      }
                    }
                    
                    if (sender) {
                      await sendErrorEmail(sender, attachment.filename || 'file', { message: errorMsg || 'Unknown error' });
                    }
                  }
                } else {
                  console.log(`File too large for free tier: ${attachment.size} bytes`);
                  if (sender) {
                    await sendSizeExceededEmail(sender, attachment.filename || 'file');
                  }
                }
              }
            } else {
              console.log('No attachments found in the email');
            }
          } catch (error) {
            console.error('Error parsing email:', error);
          }
        });
      });
    });
    
    fetch.once('error', (err: Error) => {
      console.error('Error fetching messages:', err);
    });
    
    fetch.once('end', () => {
      console.log('Done processing messages');
    });
  });
}

// Email response handlers
async function sendConfirmationEmail(to: string, txId: string, uploadType: string, fileName: string) {
  try {
    // Generate QR code for the transaction
    const qrCodeDataUrl = await QRCode.toDataURL(`https://arweave.net/${txId}`);
    
    // Get upload type friendly name
    const uploadTypeName = uploadType === 'turbo' ? 'ArDrive Turbo' : 'Arweave.js';
    
    await smtpTransport.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject: `Arweave Upload Confirmation: ${fileName}`,
      text: `Your file "${fileName}" was successfully uploaded to Arweave!\n\nTransaction ID: ${txId}\n\nUpload method: ${uploadTypeName}\n\nView: https://arweave.net/${txId}\n\nThank you for using Arweave SMTP Bridge.`,
      html: `
        <div style="font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #000; font-weight: 300; margin: 0; font-size: 28px;">Upload Successful</h1>
            <p style="color: #666; margin-top: 8px; font-size: 16px;">Your file has been permanently stored on Arweave</p>
          </div>
          
          <div style="background-color: #fff; border-radius: 8px; padding: 25px; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
            <p style="font-size: 16px; margin-bottom: 20px;">Your file <strong>${fileName}</strong> was successfully uploaded.</p>
            
            <div style="background-color: #f7f9fc; padding: 15px; border-radius: 8px; margin: 15px 0; font-family: monospace; overflow-wrap: break-word;">
              <p style="margin: 0; font-size: 14px;"><strong>Transaction ID:</strong> ${txId}</p>
              <p style="margin: 8px 0 0 0; font-size: 14px; color: #666;"><strong>Upload method:</strong> ${uploadTypeName}</p>
            </div>
            
            <div style="display: flex; flex-direction: column; align-items: center; margin: 25px 0;">
              <img src="${qrCodeDataUrl}" alt="QR Code for Transaction" style="width: 180px; height: 180px; margin-bottom: 10px;">
              <p style="color: #666; font-size: 14px; margin: 5px 0 0 0;">Scan to view your file</p>
            </div>
            
            <div style="text-align: center; margin-top: 25px;">
              <a href="https://arweave.net/${txId}" style="background-color: #000; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: 500; letter-spacing: 0.5px;">
                View File
              </a>
            </div>
          </div>
          
          <p style="color: #999; font-size: 13px; text-align: center; margin-top: 25px;">Thank you for using Arweave SMTP Bridge.</p>
        </div>
      `
    });
    console.log(`Confirmation email sent to ${to}`);
  } catch (error) {
    console.error('Error sending confirmation email:', error);
  }
}

async function sendErrorEmail(to: string, fileName: string, error: any) {
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

async function sendSizeExceededEmail(to: string, fileName: string) {
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
import { TurboFactory } from '@ardrive/turbo-sdk';
import { createTransport } from 'nodemailer';
import { simpleParser } from 'mailparser';
import Imap from 'imap';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

// Function to load JWK from file or environment variable
function loadArweaveJWK(): any {
  try {
    // Check if ARWEAVE_JWK_PATH is provided
    if (process.env.ARWEAVE_JWK_PATH) {
      const jwkPath = process.env.ARWEAVE_JWK_PATH;
      console.log(`Loading Arweave JWK from path: ${jwkPath}`);
      
      // Read and parse JWK file
      const jwkContent = fs.readFileSync(path.resolve(jwkPath), 'utf8');
      return JSON.parse(jwkContent);
    }
    
    // Fall back to ARWEAVE_JWK if path is not provided
    if (process.env.ARWEAVE_JWK) {
      console.log('Loading Arweave JWK from environment variable');
      return JSON.parse(process.env.ARWEAVE_JWK);
    }
    
    throw new Error('No Arweave JWK provided. Set either ARWEAVE_JWK_PATH or ARWEAVE_JWK');
  } catch (error) {
    console.error('Error loading Arweave JWK:', error);
    throw error;
  }
}

// Configure email and Arweave connections
const imap = new Imap({
  user: process.env.EMAIL_USER || '',
  password: process.env.EMAIL_PASSWORD || '',
  host: 'imap.gmail.com',
  port: 993,
  tls: true
});

// Load JWK and initialize Turbo
const turbo = TurboFactory.authenticated({
  privateKey: loadArweaveJWK(),
  token: 'arweave'
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

// Function to retry uploads with exponential backoff
async function retryUpload(attachment: any, maxRetries = 3): Promise<any> {
  let retryCount = 0;
  let lastError;

  while (retryCount < maxRetries) {
    try {
      console.log(`Upload attempt ${retryCount + 1}/${maxRetries} for ${attachment.filename}...`);
      
      const result = await turbo.uploadFile({
        fileStreamFactory: () => Readable.from(attachment.content),
        fileSizeFactory: () => attachment.size,
        dataItemOpts: {
          tags: [
            { 
              name: 'Content-Type', 
              value: attachment.contentType || 'application/octet-stream'
            },
            {
              name: 'File-Name',
              value: attachment.filename || 'unnamed-file'
            },
            {
              name: 'Upload-Source',
              value: 'arweave-smtp-bridge'
            }
          ]
        }
      });
      
      return result;
    } catch (error) {
      lastError = error;
      retryCount++;
      
      if (retryCount < maxRetries) {
        // Exponential backoff with jitter
        const delay = Math.min(1000 * Math.pow(2, retryCount) + Math.random() * 1000, 10000);
        console.log(`Upload failed (attempt ${retryCount}/${maxRetries}). Retrying in ${Math.round(delay/1000)} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error(`Upload failed after ${maxRetries} attempts:`, error);
        throw error;
      }
    }
  }
  
  throw lastError;
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
                    console.log(`Uploading ${attachment.filename} to Arweave...`);
                    
                    const result = await retryUpload(attachment);
                    
                    console.log(`Upload successful! Transaction ID: ${result.id}`);
                    
                    if (sender) {
                      await sendConfirmationEmail(sender, result.id, attachment.filename || 'file');
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
async function sendConfirmationEmail(to: string, txId: string, fileName: string) {
  try {
    await smtpTransport.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject: `Arweave Upload Confirmation: ${fileName}`,
      text: `Your file "${fileName}" was successfully uploaded to Arweave!\n\nTransaction ID: ${txId}\n\nView: https://arweave.net/${txId}\n\nThank you for using Arweave SMTP Bridge.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
          <h2 style="color: #3498db;">Upload Successful!</h2>
          <p>Your file <strong>${fileName}</strong> was successfully uploaded to Arweave.</p>
          <div style="background-color: #f9f9f9; padding: 10px; border-radius: 4px; margin: 15px 0;">
            <p><strong>Transaction ID:</strong> ${txId}</p>
          </div>
          <p>
            <a href="https://arweave.net/${txId}" style="background-color: #3498db; color: white; padding: 10px 15px; text-decoration: none; border-radius: 4px; display: inline-block;">
              View Your File
            </a>
          </p>
          <p style="color: #777; font-size: 0.9em; margin-top: 20px;">Thank you for using Arweave SMTP Bridge.</p>
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
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
          <h2 style="color: #e74c3c;">Upload Failed</h2>
          <p>There was an error processing your file <strong>${fileName}</strong>.</p>
          <div style="background-color: #fff9f9; padding: 10px; border-radius: 4px; margin: 15px 0; border-left: 4px solid #e74c3c;">
            <p><strong>Error:</strong> ${error?.message || 'Unknown error'}</p>
          </div>
          <p>Please try again or contact support if the issue persists.</p>
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
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
          <h2 style="color: #f39c12;">File Size Exceeded</h2>
          <p>Your file <strong>${fileName}</strong> exceeds the 100MB free tier limit for Arweave uploads.</p>
          <p>Please try uploading a smaller file.</p>
        </div>
      `
    });
    console.log(`Size exceeded email sent to ${to}`);
  } catch (error) {
    console.error('Error sending size exceeded email:', error);
  }
} 
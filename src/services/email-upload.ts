import { ParsedMail, simpleParser } from 'mailparser';
import Imap from 'imap';
import fs, { readFileSync } from 'fs';
import path from 'path';
import { retryUpload, AttachmentInfo, UploadResult } from './arweave-upload';
import { sendConfirmationEmail, sendErrorEmail, sendSizeExceededEmail } from './email-responses';
import { initUser } from './user-manager';
import { prepareEmailForUpload, saveAttachmentToTmpFile } from './file-prep';
import { uploadToArDrive } from './ardrive-upload';
import { isAllowedEmail } from './auth';
import { ArFSEntityData, TransactionID } from 'ardrive-core-js';

export interface UploadedFileInfo {
  id: string;
  dataTxId?: TransactionID;
  fileName: string;
  fileKey?: string;
}

function isUploadedFileInfo(obj: any): obj is UploadedFileInfo {
  return typeof obj?.id === 'string';
}

const imap = new Imap({
  user: process.env.EMAIL_USER || '',
  password: process.env.EMAIL_PASSWORD || '',
  host: 'imap.gmail.com',
  port: 993,
  tls: true
});

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
  const MAX_EMAILS_TO_PROCESS = 10;
  const REQUIRED_SUBJECT_KEYWORD = 'arweave';
  const searchCriteria = ['UNSEEN', ['SINCE', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]];
  const fetchOptions = {
    bodies: '',
    markSeen: true
  };
  

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
    const fetch = imap.fetch(messagesToProcess, fetchOptions);

    fetch.on('message', (msg) => {
      const chunks: Buffer[] = [];
    
      let totalChunkSize = 0;

      msg.on('body', (stream, info) => {
        if (info.which === 'BODY[]' || info.which === '') {
          console.log('📥 Starting email body stream...');
          stream.on('data', (chunk) => {
            const size = Buffer.byteLength(chunk);
            totalChunkSize += size;
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          stream.on('end', () => {
            console.log(`✅ Body stream complete. Total size: ${totalChunkSize} bytes`);
          });
        }
      });
    
      msg.on('end', async () => {
        try {
          const fullEmail = Buffer.concat(chunks);
          console.log(`📦 Parsing email (${fullEmail.length} bytes)...`);
          const parsed: ParsedMail = await simpleParser(fullEmail, {
            skipImageLinks: true,
            skipTextLinks: true,
            skipHtmlToText: true,
            skipTextToHtml: true
          });
          console.log('✅ Email parsed successfully');
          const sender = parsed.from?.value[0].address;
    
          if (!sender || !isAllowedEmail(sender)) {
            console.warn(`[ForwARd] ❌ Unauthorized email from ${sender}, skipping`);
            return;
          }
    
          const subject = parsed.subject || '';
          console.log(`Processing email from: ${sender}, Subject: "${subject}"`);
    
          const useArDrive =
            subject.toLowerCase().includes('ardrive:public') ||
            subject.toLowerCase().includes('ardrive:private');
          const isPrivate = subject.toLowerCase().includes('ardrive:private');
          const isPublic = subject.toLowerCase().includes('ardrive:public');
    
          if (useArDrive) {
            console.log('Detected ArDrive upload request');
    
            const { emlFilePath, attachments, metadata } = prepareEmailForUpload(parsed);
            const savedAttachments = attachments.map(a =>
              saveAttachmentToTmpFile(a.filename, a.content, a.contentType)
            );
    
            const user = await initUser(sender, {
              needsPublic: isPublic,
              needsPrivate: isPrivate
            });
    
            const filesToUpload = [
              {
                filepath: emlFilePath,
                filename: path.basename(emlFilePath),
                contentType: 'text/plain'
              },
              ...savedAttachments.map(a => ({
                filepath: a.path,
                filename: a.name,
                contentType: isPrivate ? 'application/octet-stream' : a.contentType || 'application/octet-stream'
              }))
            ];
    
            const rootFolderId = isPrivate
              ? user.privateDriveRootFolderId
              : user.publicDriveRootFolderId;
    
            if (!rootFolderId) {
              console.error('❌ Missing root folder ID for user:', user);
              throw new Error('Missing root folder ID for upload');
            }
    
            try {
              const uploadedEntities: ArFSEntityData[] = await uploadToArDrive(
                {
                  wallet: JSON.parse(readFileSync(process.env.ARWEAVE_JWK_PATH || './wallet.json', 'utf-8')),
                  driveId: isPrivate ? user.privateDriveId : user.publicDriveId,
                  rootFolderId: rootFolderId.valueOf(),
                  drivePassword: isPrivate ? user.privateDrivePassword : undefined
                },
                filesToUpload
              );
    
              const uploadedFiles = uploadedEntities
                .map((entity, i): UploadedFileInfo | null => {
                  const id = entity?.entityId?.valueOf();
                  if (!id) return null;
    
                  return {
                    id,
                    dataTxId: entity?.dataTxId,
                    fileName: filesToUpload[i]?.filename || 'unknown',
                    fileKey: isPrivate ? entity?.key?.toString() : undefined
                  };
                })
                .filter(isUploadedFileInfo);
    
              if (uploadedFiles.length && sender) {
                await sendConfirmationEmail(sender, uploadedFiles, 'ardrive');
              }
            } catch (err) {
              console.error('❌ ArDrive upload failed:', err);
              if (sender) {
                await sendErrorEmail(sender, 'your files', {
                  message: 'ArDrive upload failed. ' + (err?.message || 'Unknown error.')
                });
              }
            } finally {
              [emlFilePath, ...savedAttachments.map((a) => a.path)].forEach((file) => {
                try {
                  fs.unlinkSync(file);
                } catch (err) {
                  console.warn(`⚠️ Failed to delete temp file ${file}:`, err);
                }
              });
            }
    
            return;
          }
    
          // Fallback: Turbo or Arweave.js
          if (!subject.toLowerCase().includes(REQUIRED_SUBJECT_KEYWORD)) {
            console.log(`Skipping email: Subject does not contain "${REQUIRED_SUBJECT_KEYWORD}"`);
            return;
          }
    
          if (parsed.attachments?.length > 0) {
            for (const attachment of parsed.attachments) {
              if (attachment.size <= 100 * 1024 * 1024) {
                try {
                  const result: UploadResult = await retryUpload({
                    filename: attachment.filename,
                    content: attachment.content,
                    size: attachment.size,
                    contentType: attachment.contentType
                  });
    
                  if (sender) {
                    await sendConfirmationEmail(sender, [
                      {
                        id: result.id,
                        fileName: attachment.filename || 'file'
                      }
                    ], result.type);
                  }
                } catch (error) {
                  const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                  if (sender) {
                    await sendErrorEmail(sender, attachment.filename || 'file', { message: errorMsg });
                  }
                }
              } else {
                if (sender) {
                  await sendSizeExceededEmail(sender, attachment.filename || 'file');
                }
              }
            }
          } else {
            console.log('No attachments found in the email');
          }
    
        } catch (error) {
          console.error('❌ Error parsing email:', error);
        }
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
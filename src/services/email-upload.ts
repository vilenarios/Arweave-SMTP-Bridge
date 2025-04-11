import { MailParser } from 'mailparser';
import Imap from 'imap';
import fs, { readFileSync } from 'fs';
import path from 'path';
import { retryUpload, UploadResult } from './arweave-upload';
import { sendArDriveConfirmationEmail, sendConfirmationEmail, sendErrorEmail, sendSizeExceededEmail } from './email-responses';
import { initUser } from './user-manager';
import { sanitizeFilename } from './file-prep';
import { uploadToArDrive } from './ardrive-upload';
import { isAllowedEmail } from './auth';
import { TransactionID } from 'ardrive-core-js';
import { Readable } from 'stream';
import { finished } from 'stream/promises';

const processingUids = new Set<number>();

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
  console.log('📡 Monitoring inbox for new emails...');

  imap.once('ready', () => {
    console.log('✅ IMAP connection established');
    imap.openBox('INBOX', false, async (err) => {
      if (err) {
        console.error('❌ Error opening inbox:', err);
        return;
      }

      // Process unseen emails immediately at startup
      await processMessages();

      // Continue watching for new incoming emails
      imap.on('mail', processMessages);
    });
  });

  imap.once('error', (err: Error) => {
    console.error('❌ IMAP error:', err);
  });

  imap.once('end', () => {
    console.log('🔌 IMAP connection closed');
    // 🔁 Try to reconnect after delay
    setTimeout(() => {
      console.log('🔁 Reconnecting to IMAP...');
      imap.connect();
    }, 10000); // Reconnect after 10 seconds
  });

  imap.connect();
}

async function processMessages() {
  const MAX_EMAILS_TO_PROCESS = 10;
  const REQUIRED_SUBJECT_KEYWORD = 'arweave';
  const searchCriteria = ['UNSEEN', ['SINCE', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]];
  const fetchOptions = {
    bodies: '',
    markSeen: false
  };

  console.log('🔍 Searching for unseen messages...');
  imap.search(searchCriteria, (err, results) => {
    if (err) {
      console.error('❌ Search error:', err);
      return;
    }

    if (results.length === 0) {
      console.log('📭 No new messages');
      return;
    }

    console.log(`📨 Found ${results.length} unseen messages`);

    const uniqueUids = results.filter(uid => !processingUids.has(uid));
    if (uniqueUids.length === 0) {
      console.log('📭 All unseen messages already processing');
      return;
    }
  
    uniqueUids.forEach(uid => processingUids.add(uid));
    console.log(`📨 Found ${uniqueUids.length} unseen + unprocessed messages`);
  
    const fetch = imap.fetch(uniqueUids, fetchOptions);
    const messageHandlers: Promise<void>[] = [];

    fetch.on('message', async (msg, seqno) => {
      const messageHandler = new Promise<void>((resolve, reject) => {
        const chunks: Buffer[] = [];

        msg.on('body', async (stream, info) => {
          if (info.which === '' || info.which === 'BODY[]') {
            console.time(`⏱️ [${seqno}] IMAP body download`);
            let i = 0
            stream.on('data', (chunk) => {
              i += 1
              console.log ("CHUNK NUMBER: ", i)
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            stream.on('end', () => {
              console.timeEnd(`⏱️ [${seqno}] IMAP body download`);
            });
          }
        });

        const totalLabel = `⏱️ [${seqno}] Total processing time`;
        console.time(totalLabel);

        msg.on('end', async () => {
          const totalLabel = `⏱️ [${seqno}] Total message processing`;
          console.time(totalLabel);
        
          try {
            const raw = Buffer.concat(chunks);
            const emailStream = Readable.from(raw);
        
            const attachments: { filename: string; path: string; contentType: string }[] = [];
            let sender = '';
            let subject = '';
            let emailText = '';
            let messageId = '';
            let date = new Date().toISOString();
        
            async function parseAndWriteAttachments(): Promise<void> {
              return new Promise((resolve, reject) => {
                const parser = new MailParser();     

                parser.on('headers', async (headers) => {
                  subject = headers.get('subject') as string || '';
                  messageId = headers.get('message-id') as string || '';
                  const fromHeader = headers.get('from');
                  if (fromHeader && typeof fromHeader === 'object' && 'value' in fromHeader) {
                    const value = (fromHeader as any).value;
                    if (Array.isArray(value) && value.length > 0) {
                      sender = value[0].address;
                    }
                  }
                  const dateHeader = headers.get('date');
                  if (dateHeader instanceof Date) {
                    date = dateHeader.toISOString();
                  }
                  console.log(`🧾 Email from ${sender}, subject: "${subject}"`);
                });

                const attachmentPromises: Promise<void>[] = [];
                parser.on('data', (data) => {
                  if (data.type === 'attachment') {
                    const fileName = data.filename || `attachment-${Date.now()}`;
                    const safeName = sanitizeFilename(fileName);
                    const tmpDir = './tmp';
                    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                    const filePath = path.join(tmpDir, `${Date.now()}-${safeName}`);
        
                    console.log(`📎 Writing attachment to disk: ${filePath}`);
                    const writeStream = fs.createWriteStream(filePath);
                    console.log(`📎 Attachment written: ${filePath}`);
                    data.content.pipe(writeStream);
                    data.release();
                    console.log(`📎 Data content piped: ${filePath}`);
       
                    const label = `⏱️ [${seqno}] Write ${safeName}`;
                    console.time(label);
        
                    const writePromise = finished(writeStream)
                      .then(() => {
                        console.timeEnd(label);
                        attachments.push({
                          filename: safeName,
                          path: filePath,
                          contentType: data.contentType || 'application/octet-stream'
                        });
                      })
                      .catch((err) => {
                        console.error(`❌ Stream write error for ${filePath}:`, err);
                      });
                    console.log(`📎 Write Promise finished: ${filePath}`)
                    attachmentPromises.push(writePromise);
                  }
        
                  if (data.type === 'text') {
                    console.log('📝 Email text content received.');
                    emailText = data.text || data.html || '(no body)';
                  }
                });
        
                parser.on('end', async () => {
                  console.log ("WAIT FOR THE ATTACHMENTS!")
                  await Promise.all(attachmentPromises); // ✅ Wait here
                  console.log ("DONE WAITING FOR ATTACHMENTS!")
                  resolve();
                });
        
                parser.on('error', reject);
        
                console.time(`⏱️ [${seqno}] MailParser total`);
                console.log ("EMAIL STREAM PARSING")
                emailStream.pipe(parser);
                console.log ("EMAIL STREAM PARSED")
              });
            }
        
            console.log ("PARSING ATTACHMENTS")
            await parseAndWriteAttachments();
            console.log ("ATTACHMENTS PARSED")
            console.timeEnd(`⏱️ [${seqno}] MailParser total`);
        
            if (!sender || !isAllowedEmail(sender)) {
              console.warn(`[ForwARd] ❌ Unauthorized email from ${sender}, skipping`);
              return;
            }
        
            const useArDrive =
              subject.toLowerCase().includes('ardrive:public') ||
              subject.toLowerCase().includes('ardrive:private');
            const isPrivate = subject.toLowerCase().includes('ardrive:private');
            const isPublic = subject.toLowerCase().includes('ardrive:public');
        
            if (useArDrive) {
              const tmpDir = './tmp';
              if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
              const baseName = sanitizeFilename(`${subject.slice(0, 50)}-${date}`);
              const emlFilePath = path.join(tmpDir, `${baseName}.txt`);
              fs.writeFileSync(emlFilePath, emailText);
        
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
                ...attachments.map(a => ({
                  filepath: a.path,
                  filename: a.filename,
                  contentType: isPrivate ? 'application/octet-stream' : a.contentType
                }))
              ];
        
              const rootFolderId = isPrivate ? user.privateDriveRootFolderId : user.publicDriveRootFolderId;
              const driveId = isPrivate ? user.privateDriveId : user.publicDriveId;
              const wallet = JSON.parse(readFileSync(process.env.ARWEAVE_JWK_PATH || './wallet.json', 'utf-8'));
        
              console.time(`📤 [${seqno}] Upload to ArDrive`);
              const uploadedEntities = await uploadToArDrive({
                wallet,
                driveId,
                rootFolderId: rootFolderId.valueOf(),
                drivePassword: isPrivate ? user.privateDrivePassword : undefined
              }, filesToUpload);
              console.timeEnd(`📤 [${seqno}] Upload to ArDrive`);
        
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
        
              if (uploadedFiles.length) {
                await sendArDriveConfirmationEmail(sender, uploadedFiles, driveId, 'ardrive');
              }
        
              imap.addFlags(seqno, '\\Seen', (err) => {
                if (err) console.error(`⚠️ Failed to mark email ${seqno} as seen:`, err);
                else console.log(`✅ Email ${seqno} marked as seen.`);
              });
        
              [emlFilePath, ...attachments.map(a => a.path)].forEach(file => {
                try {
                  fs.unlinkSync(file);
                } catch (err) {
                  console.warn(`⚠️ Cleanup failed: ${file}`, err);
                }
              });
        
              return;
            }        

            // Fallback: Arweave or Turbo
            if (!subject.toLowerCase().includes(REQUIRED_SUBJECT_KEYWORD)) {
              console.log('⏩ Skipping: subject does not contain required keyword');
              return;
            }

            for (const attachment of attachments) {
              const fileContent = fs.readFileSync(attachment.path);
              if (fileContent.length <= 100 * 1024 * 1024) {
                try {
                  const result: UploadResult = await retryUpload({
                    filename: attachment.filename,
                    content: fileContent,
                    size: fileContent.length,
                    contentType: attachment.contentType
                  });

                  await sendConfirmationEmail(sender, result.id, result.type, attachment.filename);
                } catch (err) {
                  await sendErrorEmail(sender, attachment.filename, {
                    message: err instanceof Error ? err.message : 'Unknown error'
                  });
                }
              } else {
                await sendSizeExceededEmail(sender, attachment.filename);
              }
            }

            // Mark the email as seen since we are finished
            imap.addFlags(seqno, '\\Seen', (err) => {
              if (err) {
                console.error(`⚠️ Failed to mark email ${seqno} as seen:`, err);
              } else {
                console.log(`✅ Email ${seqno} marked as seen.`);
              }
            });

            for (const file of attachments.map(a => a.path)) {
              try {
                fs.unlinkSync(file);
              } catch (err) {
                console.warn(`⚠️ Cleanup failed for fallback file: ${file}`, err);
              }
            }

          } catch (err) {
            console.error('❌ Failed to process message:', err);
          } finally {
            console.timeEnd(totalLabel);
            resolve();
          }
        });
      });
      messageHandlers.push(messageHandler);
    });

    fetch.once('error', (err) => {
      console.error('❌ Fetch error:', err);
    });

    fetch.once('end', async () => {
      console.log('📦 Waiting for all message processing to finish...');
      await Promise.all(messageHandlers);
      console.log('✅ All message handlers completed.');
    });
  });
}


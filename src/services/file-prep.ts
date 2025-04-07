import { ParsedMail } from 'mailparser';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import fs from 'fs';
import path from 'path';

const TEMP_DIR = process.env.FORWARD_TEMP_DIR || join(__dirname, '../../tmp');

if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR);

function sanitizeFilename(text: string) {
  return text.replace(/[^a-z0-9_\-\.]/gi, '_');
}

function extractAddresses(addr: ParsedMail['to'] | ParsedMail['from']): string {
    if (!addr) return 'unknown';
    if (Array.isArray(addr)) {
      return addr.map(a => a.text).join(', ');
    }
    if ('value' in addr) {
      return addr.value.map(a => a.address).join(', ');
    }
    return 'unknown';
  }
  
  export function prepareEmailForUpload(email: ParsedMail): {
    emlFilePath: string;
    attachments: { filename: string; content: Buffer, contentType: string }[];
    metadata: {
      subject: string;
      from: string;
      to: string;
      date: string;
      messageId?: string;
    };
  } {
    const subject = email.subject || '(no subject)';
    const from = extractAddresses(email.from);
    const to = extractAddresses(email.to);
    const date = email.date?.toISOString?.() || new Date().toISOString();
    const messageId = email.messageId;
  
    const baseName = sanitizeFilename(`${subject.slice(0, 50)}-${date}`);
    const emlFilePath = join(TEMP_DIR, `${baseName}.txt`);
  
    const headerBlock = [
      `Subject: ${subject}`,
      `From: ${from}`,
      `To: ${to}`,
      `Date: ${date}`,
      messageId ? `Message-ID: ${messageId}` : '',
      '',
    ].join('\n');
  
    const body = email.text || email.html || '(no body found)';
    const content = `${headerBlock}${body}`;
  
    try {
      writeFileSync(emlFilePath, content);
      console.log(`[ForwARd:file-prep] Email written: ${emlFilePath}`);
    } catch (err) {
      console.error(`[ForwARd:file-prep] Failed to write email file: ${emlFilePath}`, err);
      throw err;
    }
  
    const attachments = (email.attachments || []).map((a, i) => ({
      filename: sanitizeFilename(`${a.filename}-${date}` || `attachment-${i}-${date}`),
      content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content),
      contentType: a.contentType || 'application/octet-stream'
    }));
  
    console.log(`[ForwARd:file-prep] Found ${attachments.length} attachment(s)`);
  
    return {
      emlFilePath,
      attachments,
      metadata: { subject, from, to, date, messageId },
    };
  }
  
  export interface SavedAttachment {
    name: string;
    path: string;
    contentType?: string;
  }

export function saveAttachmentToTmpFile(
    filename: string,
    content: Buffer,
    contentType?: string
    ): SavedAttachment {
    const safeName = filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const fullPath = path.join(TEMP_DIR, `${Date.now()}-${safeName}`);

    fs.writeFileSync(fullPath, content);
    return { path: fullPath, name: safeName, contentType };
}
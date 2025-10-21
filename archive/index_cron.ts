import 'dotenv/config';
import { ImapFlow } from 'imapflow';
import { writeFileSync, createReadStream, readdirSync, statSync, unlinkSync } from 'fs';
import path from 'path';
import cron from 'node-cron';
import { MailParser, AttachmentStream } from 'mailparser';
import { formatAddresses, writeAttachment, writeEmailText } from './src/services/utils';
import pLimit from 'p-limit';

const limit = pLimit(5);
const DOWNLOAD_DIR = process.env.FORWARD_TEMP_DIR || '';
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || '';

export async function fetchRawEmails(): Promise<string[]> {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASSWORD,
    },
    logger: false,
  });

  await client.connect();
  console.log('📡 Connected to IMAP');

  const rawMessages: string[] = [];

  const lock = await client.getMailboxLock('INBOX');
  try {
    const sinceDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const messages = await client.search({ seen: false, since: sinceDate });

    if (!messages.length) {
      console.log('📭 No new mail');
      return rawMessages;
    }

    console.log(`📨 Found ${messages.length} new messages`);

    for (const seq of messages) {
      const { uid } = await client.fetchOne(seq, { uid: true });
      const source = await client.download(seq);

      const fileName = `raw_email_uid_${uid}.eml`;
      const fullPath = path.join(DOWNLOAD_DIR, fileName);
      const chunks: Buffer[] = [];

      for await (const chunk of source.content) {
        chunks.push(chunk);
      }

      const fullContent = Buffer.concat(chunks);
      writeFileSync(fullPath, fullContent);
      rawMessages.push(fullPath);
      console.log(`📄 Saved raw email UID ${uid} to ${fileName}`);

      await client.messageFlagsAdd(seq, ['\\Seen']);
      console.log(`✅ Marked UID ${uid} as seen`);
    }
  } catch (err) {
    console.error('❌ Error fetching raw emails:', err);
  } finally {
    lock.release();
    await client.logout();
    console.log('📬 IMAP connection closed');
  }

  return rawMessages;
}

export async function parseSavedEmails(): Promise<void> {
  const files = readdirSync(DOWNLOAD_DIR).filter(f => f.endsWith('.eml'));

  for (const file of files) {
    const start = Date.now();
    const fullPath = path.join(DOWNLOAD_DIR, file);
    const stats = statSync(fullPath);
    console.log(`📂 Parsing ${file} (${(stats.size / 1024).toFixed(1)} KB)`);

    const stream = createReadStream(fullPath);
    const parser = new MailParser();
    const attachmentTasks: Promise<any>[] = [];

    let parsed: any = {
      headers: {},
      text: '',
      html: '',
    };

    parser.on('headers', headers => {
      parsed.headers = headers;
    });

    parser.on('data', data => {
      if (data.type === 'text') {
        parsed.text = data.text;
        parsed.html = data.html;
      } else if (data.type === 'attachment') {
        const originalName = data.filename || 'unnamed';
        const fromAddress = parsed.headers.get('from')?.text?.replace(/[^a-zA-Z0-9@._-]/g, '_') || 'unknown';
        const dateObj = parsed.headers.get('date') || new Date();
        const timestampSlug = new Date(dateObj).toISOString().replace(/[:]/g, '-');
        const cleanedFilename = `from_${fromAddress}_date_${timestampSlug}_type_attachment_name_${originalName}`;

        const task = limit(async () => {
          await writeAttachment(data.content, cleanedFilename, DOWNLOAD_DIR);
          console.log(`✅ Saved attachment ${originalName}`);
          data.release();
        });

        attachmentTasks.push(task);
      }
    });

    await new Promise<void>((resolve, reject) => {
      parser.once('end', resolve);
      parser.once('error', reject);
      stream.pipe(parser);
    });

    await Promise.all(attachmentTasks);

    const from = formatAddresses(parsed.headers.get('from'));
    const to = formatAddresses(parsed.headers.get('to'));
    const cc = formatAddresses(parsed.headers.get('cc'));
    const bcc = formatAddresses(parsed.headers.get('bcc'));
    const subject = parsed.headers.get('subject') || '(No Subject)';
    const dateObj = parsed.headers.get('date') || new Date();
    const date = new Date(dateObj).toUTCString();
    const timestampSlug = new Date(dateObj).toISOString().replace(/[:]/g, '-');
    const fromAddress = parsed.headers.get('from')?.text?.replace(/[^a-zA-Z0-9@._-]/g, '_') || 'unknown';
    const emailFileName = `from_${fromAddress}_date_${timestampSlug}_type_email_name_email.txt`;

    const emailText = [
      `From: ${from}`,
      `To: ${to}`,
      cc && `Cc: ${cc}`,
      bcc && `Bcc: ${bcc}`,
      `Date: ${date}`,
      `Subject: ${subject}`,
      '',
      '--- TEXT BODY ---',
      parsed.text || '[no text body]',
      '',
      '--- HTML BODY ---',
      parsed.html || '[no html body]',
    ].filter(Boolean).join('\n');

    await writeEmailText(emailText, emailFileName, DOWNLOAD_DIR);
    console.log(`📄 Parsed and saved email text to ${emailFileName}`);

    unlinkSync(fullPath);
    console.log(`🧹 Cleaned up ${file} after processing`);
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`⏱️ Finished processing ${file} in ${duration} seconds`);
  }
}

cron.schedule('*/1 * * * *', async () => {
  console.log('\n🕒 Running fetchRawEmails() at', new Date().toISOString());
  const files = await fetchRawEmails();
  if (files.length) {
    await parseSavedEmails();
  }
});

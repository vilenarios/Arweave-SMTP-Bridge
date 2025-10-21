import 'dotenv/config';
import Imap from 'node-imap';
import { simpleParser, Attachment } from 'mailparser';
import { formatAddresses, writeAttachment, writeEmailText } from './src/services/utils';
import pLimit from 'p-limit';
import { Readable } from 'stream';

const limit = pLimit(5);
const DOWNLOAD_DIR = process.env.FORWARD_TEMP_DIR || '';
const searchCriteria = ['UNSEEN', ['SINCE', new Date(Date.now() - 240 * 60 * 60 * 1000).toISOString()]];

const imap = new Imap({
  user: process.env.EMAIL_USER || '',
  password: process.env.EMAIL_PASSWORD || '',
  host: 'imap.gmail.com',
  port: 993,
  tls: true,
});

function openInbox(cb: (err: Error | null, box?: Imap.Box) => void) {
  imap.openBox('INBOX', false, cb);
}

imap.once('ready', () => {
  openInbox((err) => {
    if (err) throw err;

    imap.search(searchCriteria, (err, results) => {
      if (err || !results || results.length === 0) {
        console.log('No emails found.');
        imap.end();
        return;
      }

      const fetch = imap.fetch(results, { bodies: '', struct: true });
      const messagePromises: Promise<void>[] = [];

      fetch.on('message', (msg, seqno) => {
        const messagePromise = new Promise<void>((resolve) => {
          let uid: number;
          let parsed: any;

          msg.on('attributes', (attrs: Imap.ImapMessageAttributes) => {
            uid = attrs.uid;
          });

          msg.on('body', async (stream: NodeJS.ReadableStream) => {
            const readable = stream as Readable;
            console.time(`⏱️ simpleParser UID ${uid}`);
            try {
              parsed = await simpleParser(readable);
              console.timeEnd(`⏱️ simpleParser UID ${uid}`);
            } catch (err) {
              console.error(`❌ Failed to parse UID ${uid}`, err);
            }
          });

          msg.on('end', async () => {
            if (!parsed) {
              resolve();
              return;
            }

            const attachments = parsed.attachments as Attachment[];
            const rawFrom = parsed.from?.value[0]?.address || 'unknown';
            const fromAddress = rawFrom.replace(/[^a-zA-Z0-9@._-]/g, '_');
            const dateObj = parsed.date || new Date();
            const timestampSlug = dateObj.toISOString().replace(/[:]/g, '-');
            const emailFileName = `from_${fromAddress}_uid_${uid}_date_${timestampSlug}_type_email_name_email.txt`;

            const from = formatAddresses(parsed.from);
            const to = formatAddresses(parsed.to);
            const cc = formatAddresses(parsed.cc);
            const bcc = formatAddresses(parsed.bcc);
            const subject = parsed.subject || '(No Subject)';
            const date = dateObj.toUTCString();

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
            console.log(`📄 Saved email body to ${emailFileName}`);

            const tasks = attachments.map((att) => {
              const originalName = att.filename || 'unnamed';
              const cleanedFilename = `from_${fromAddress}_uid_${uid}_date_${timestampSlug}_type_attachment_name_${originalName}`;

              return limit(() =>
                writeAttachment(att.content, cleanedFilename, DOWNLOAD_DIR)
                  .then((filePath) =>
                    console.log(`✅ Saved attachment ${originalName} as ${filePath}`)
                  )
                  .catch((err) =>
                    console.error(`❌ Failed to save ${originalName} from UID ${uid}`, err)
                  )
              );
            });

            await Promise.all(tasks);

            imap.addFlags(uid, ['\\Seen'], (err) => {
              if (err) {
                console.error(`⚠️ Failed to mark email UID ${uid} as seen:`, err);
              } else {
                console.log(`✅ Email UID ${uid} marked as seen.`);
              }
              resolve();
            });
          });
        });

        messagePromises.push(messagePromise);
      });

      fetch.once('end', async () => {
        console.log('✅ All emails fetched. Waiting for processing...');
        await Promise.all(messagePromises);
        console.log('🚀 Done processing all emails.');
        // imap.end(); // uncomment if you want to terminate connection
      });
    });
  });
});

imap.once('error', (err: Error) => {
  console.error('IMAP error:', err);
});

imap.once('end', () => {
  console.log('📬 IMAP connection ended.');
});

imap.connect();

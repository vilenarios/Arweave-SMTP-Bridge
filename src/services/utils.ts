import * as fs from 'fs';
import { writeFile } from 'fs/promises';
import { AddressObject } from 'mailparser';
import { mkdirp } from 'mkdirp';
import * as path from 'path';
import { Readable } from 'stream';

export async function writeAttachment(
    content: Buffer,
    fullFilename: string,
    downloadDir: string
  ): Promise<string> {
    const fullPath = path.join(downloadDir, fullFilename);
    await mkdirp(downloadDir);
  
    return new Promise((resolve, reject) => {
      const stream = Readable.from(content);
      const writeStream = fs.createWriteStream(fullPath);
      stream.pipe(writeStream);
      stream.on('error', reject);
      writeStream.on('finish', () => resolve(fullPath));
      writeStream.on('error', reject);
    });
  }

  export async function writeEmailText(
    content: string,
    fullFilename: string,
    downloadDir: string
  ): Promise<string> {
    const fullPath = path.join(downloadDir, fullFilename);
    await mkdirp(downloadDir);
    await writeFile(fullPath, content, 'utf8');
    return fullPath;
  }
  
  export function formatAddresses(field: AddressObject | AddressObject[] | undefined): string {
    if (!field) return 'Unknown';
    const values = Array.isArray(field)
      ? field.flatMap((f) => f.value)
      : field.value;
    return values.map((a) => `${a.name ? `${a.name} <${a.address}>` : a.address}`).join(', ');
  }

  
  // Sleep function that returns a promise which resolves after the given milliseconds.
  export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
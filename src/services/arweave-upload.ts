import { TurboFactory } from '@ardrive/turbo-sdk';
import Arweave from 'arweave';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';

// Interface for attachment information
export interface AttachmentInfo {
  filename?: string;
  content: Buffer;
  size: number;
  contentType?: string;
}

// Result of upload operation
export interface UploadResult {
  id: string;
  type: 'turbo' | 'arweave-js';
}

// Function to load JWK from file or environment variable
export function loadArweaveJWK(): any {
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

// Turbo implementation
export class TurboUploader {
  private turbo;

  constructor() {
    const jwk = loadArweaveJWK();
    this.turbo = TurboFactory.authenticated({
      privateKey: jwk,
      token: 'arweave'
    });
  }

  async uploadFile(attachment: AttachmentInfo): Promise<UploadResult> {
    const result = await this.turbo.uploadFile({
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

    return {
      id: result.id,
      type: 'turbo'
    };
  }
}

// Arweave.js implementation
export class ArweaveJSUploader {
  private arweave;
  private jwk;

  constructor() {
    this.arweave = Arweave.init({
      host: 'arweave.net',
      port: 443,
      protocol: 'https',
      timeout: 60000
    });
    this.jwk = loadArweaveJWK();
  }

  async uploadFile(attachment: AttachmentInfo): Promise<UploadResult> {
    try {
      console.log(`Preparing transaction for ${attachment.filename} using Arweave.js...`);
      
      // Create and sign the transaction
      const transaction = await this.arweave.createTransaction({ 
        data: attachment.content
      }, this.jwk);
      
      // Add tags
      transaction.addTag('Content-Type', attachment.contentType || 'application/octet-stream');
      transaction.addTag('File-Name', attachment.filename || 'unnamed-file');
      transaction.addTag('Upload-Source', 'arweave-smtp-bridge');
      
      // Sign the transaction
      await this.arweave.transactions.sign(transaction, this.jwk);
      
      // Get the transaction ID
      const txId = transaction.id;
      
      // Use the uploader to upload transaction in chunks
      console.log(`Starting chunked upload for transaction ${txId}...`);
      const uploader = await this.arweave.transactions.getUploader(transaction);
      
      while (!uploader.isComplete) {
        await uploader.uploadChunk();
        console.log(`${uploader.pctComplete}% complete, ${uploader.uploadedChunks}/${uploader.totalChunks}`);
      }
      
      return {
        id: txId,
        type: 'arweave-js'
      };
    } catch (error) {
      console.error('Error in ArweaveJS upload:', error);
      throw error;
    }
  }
}

// Factory to create the appropriate uploader based on configuration
export function createUploader(): TurboUploader | ArweaveJSUploader {
  const uploaderType = process.env.ARWEAVE_SDK?.toLowerCase() || 'turbo';
  
  console.log(`Using ${uploaderType} for Arweave uploads`);
  
  if (uploaderType === 'arweave-js') {
    return new ArweaveJSUploader();
  } else {
    return new TurboUploader();
  }
}

// Function to retry uploads with exponential backoff
export async function retryUpload(
  attachment: AttachmentInfo, 
  maxRetries = 3
): Promise<UploadResult> {
  const uploader = createUploader();
  let retryCount = 0;
  let lastError;

  while (retryCount < maxRetries) {
    try {
      console.log(`Upload attempt ${retryCount + 1}/${maxRetries} for ${attachment.filename}...`);
      
      const result = await uploader.uploadFile(attachment);
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
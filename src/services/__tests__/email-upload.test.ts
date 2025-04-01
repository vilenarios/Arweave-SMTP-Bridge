import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as emailUpload from '../email-upload';

// Mock dependencies
mock.module('nodemailer', () => ({
  createTransport: () => ({
    sendMail: mock.fn(() => Promise.resolve({ messageId: 'test-message-id' }))
  })
}));

mock.module('@ardrive/turbo-sdk', () => ({
  TurboFactory: {
    authenticated: () => ({
      uploadFile: mock.fn(() => Promise.resolve({
        id: 'test-tx-id',
        owner: 'test-owner',
        dataCaches: ['test-cache-url'],
        fastFinalityIndexes: ['test-index'],
        winc: '1000'
      }))
    })
  }
}));

// Mock filesystem
mock.module('fs', () => ({
  ...fs,
  readFileSync: mock.fn(() => JSON.stringify({ kty: 'RSA', n: 'test', e: 'AQAB' }))
}));

// Mock IMAP
class MockEventEmitter {
  events: Record<string, Function[]> = {};
  
  on(event: string, callback: Function) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(callback);
    return this;
  }
  
  once(event: string, callback: Function) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(callback);
    return this;
  }
  
  emit(event: string, ...args: any[]) {
    if (this.events[event]) {
      this.events[event].forEach(callback => callback(...args));
    }
    return this;
  }
}

class MockImap extends MockEventEmitter {
  connect = mock.fn(() => {
    setTimeout(() => this.emit('ready'), 10);
    return this;
  });
  
  openBox = mock.fn((boxName, readOnly, callback) => {
    callback(null);
    return this;
  });
  
  search = mock.fn((criteria, callback) => {
    callback(null, [1]);
    return this;
  });
  
  fetch = mock.fn(() => {
    const fetch = new MockEventEmitter();
    
    setTimeout(() => {
      const msg = new MockEventEmitter();
      
      setTimeout(() => {
        const stream = new MockEventEmitter();
        
        setTimeout(() => {
          stream.emit('data', Buffer.from(`From: test@example.com
To: service@example.com
Subject: Test Email

Test content`));
          
          stream.emit('end');
        }, 10);
        
        msg.emit('body', stream);
      }, 10);
      
      fetch.emit('message', msg);
      fetch.emit('end');
    }, 10);
    
    return fetch;
  });
}

mock.module('imap', () => MockImap);

// Mock SimpleParser
mock.module('mailparser', () => ({
  simpleParser: mock.fn(() => Promise.resolve({
    from: { value: [{ address: 'test@example.com' }] },
    to: { value: [{ address: 'service@example.com' }] },
    subject: 'Test Email with Attachment',
    text: 'Please upload this file',
    attachments: [
      {
        filename: 'test-file.txt',
        contentType: 'text/plain',
        content: Buffer.from('Test file content'),
        size: 17
      }
    ]
  }))
}));

describe('Email Upload Service', () => {
  beforeEach(() => {
    process.env.EMAIL_USER = 'test@example.com';
    process.env.EMAIL_PASSWORD = 'test-password';
    process.env.ARWEAVE_JWK = JSON.stringify({ kty: 'RSA', n: 'test', e: 'AQAB' });
    delete process.env.ARWEAVE_JWK_PATH;
  });
  
  afterEach(() => {
    mock.restoreAll();
    delete process.env.ARWEAVE_JWK_PATH;
  });
  
  it('should initialize properly with JWK string', async () => {
    await expect(emailUpload.handleIncomingEmails()).resolves.not.toThrow();
  });
  
  it('should initialize properly with JWK file path', async () => {
    delete process.env.ARWEAVE_JWK;
    process.env.ARWEAVE_JWK_PATH = './test-wallet.json';
    
    await expect(emailUpload.handleIncomingEmails()).resolves.not.toThrow();
    expect(fs.readFileSync).toHaveBeenCalled();
  });
}); 
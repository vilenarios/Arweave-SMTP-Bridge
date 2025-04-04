import { describe, it, expect } from 'bun:test';
import * as QRCode from 'qrcode';

describe('QR Code Generation', () => {
  it('should generate a valid data URL for a transaction ID', async () => {
    const txId = 'testTransactionId123';
    const url = `https://arweave.net/${txId}`;
    
    // Generate QR code
    const dataUrl = await QRCode.toDataURL(url);
    
    // Verify it's a valid data URL
    expect(dataUrl).toBeTypeOf('string');
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    
    // Verify it has reasonable length (not empty or too small)
    expect(dataUrl.length).toBeGreaterThan(100);
  });
}); 
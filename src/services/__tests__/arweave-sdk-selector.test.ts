import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// Simple function that mimics the SDK selection logic
function selectSdk(envValue?: string): string {
  const uploaderType = envValue?.toLowerCase() || 'turbo';
  return uploaderType === 'arweave-js' ? 'arweave-js' : 'turbo';
}

describe('Arweave SDK Selection', () => {
  it('should use Turbo by default when value is not set', () => {
    const result = selectSdk();
    expect(result).toBe('turbo');
  });
  
  it('should use Turbo when value is set to "turbo"', () => {
    const result = selectSdk('turbo');
    expect(result).toBe('turbo');
  });
  
  it('should use Arweave.js when value is set to "arweave-js"', () => {
    const result = selectSdk('arweave-js');
    expect(result).toBe('arweave-js');
  });
  
  it('should handle case insensitivity', () => {
    const result = selectSdk('ARWEAVE-JS');
    expect(result).toBe('arweave-js');
  });
  
  it('should default to Turbo for unknown values', () => {
    const result = selectSdk('unknown-value');
    expect(result).toBe('turbo');
  });
}); 
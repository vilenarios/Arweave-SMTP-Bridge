import { type ParsedMail } from 'mailparser';
import { createLogger } from '../config/logger';

const logger = createLogger('email-security');

export interface AuthenticationResult {
  isAuthenticated: boolean;
  dkimPass: boolean;
  spfPass: boolean;
  dmarcPass: boolean;
  failureReason?: string;
}

/**
 * Verify email authentication (DKIM, SPF, DMARC)
 * Checks Authentication-Results header to prevent email spoofing
 *
 * CRITICAL SECURITY: This prevents attackers from forging sender addresses
 */
export function verifyEmailAuthentication(email: ParsedMail, expectedSender: string): AuthenticationResult {
  const result: AuthenticationResult = {
    isAuthenticated: false,
    dkimPass: false,
    spfPass: false,
    dmarcPass: false,
  };

  // Get Authentication-Results header
  const authResults = email.headers.get('authentication-results');

  if (!authResults) {
    result.failureReason = 'No Authentication-Results header found';
    logger.warn({ from: expectedSender }, result.failureReason);
    return result;
  }

  const authString = Array.isArray(authResults) ? authResults.join(' ') : String(authResults);

  logger.debug({ from: expectedSender, authResults: authString }, 'Checking authentication');

  // Check DKIM
  if (authString.match(/dkim\s*=\s*pass/i)) {
    result.dkimPass = true;
  }

  // Check SPF
  if (authString.match(/spf\s*=\s*pass/i)) {
    result.spfPass = true;
  }

  // Check DMARC
  if (authString.match(/dmarc\s*=\s*pass/i)) {
    result.dmarcPass = true;
  }

  // Email is authenticated if at least DKIM OR SPF passes
  // DKIM is preferred as it's more reliable, but SPF alone is acceptable
  if (result.dkimPass || result.spfPass) {
    result.isAuthenticated = true;
    logger.info(
      {
        from: expectedSender,
        dkim: result.dkimPass,
        spf: result.spfPass,
        dmarc: result.dmarcPass
      },
      'Email authentication passed'
    );
  } else {
    result.failureReason = 'Neither DKIM nor SPF passed authentication';
    logger.warn(
      {
        from: expectedSender,
        authResults: authString,
        dkim: result.dkimPass,
        spf: result.spfPass,
        dmarc: result.dmarcPass
      },
      'Email failed authentication checks'
    );
  }

  return result;
}

/**
 * Check if email authentication should be enforced for this sender
 * Can be disabled for development/testing
 */
export function shouldEnforceAuthentication(): boolean {
  // For now, enforce in production only
  // Can add environment variable to control this
  return process.env.NODE_ENV === 'production' || process.env.ENFORCE_EMAIL_AUTH === 'true';
}

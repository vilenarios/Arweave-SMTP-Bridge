/**
 * OAuth2 Token Service for Microsoft 365
 * Handles automatic token refresh for IMAP and SMTP authentication
 */

import { config } from '../config/env';
import { logger } from '../config/logger';

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

class OAuth2Service {
  private cachedToken: CachedToken | null = null;
  private refreshPromise: Promise<string> | null = null;

  /**
   * Check if OAuth2 is configured
   */
  isOAuth2Configured(): boolean {
    return !!(
      config.OAUTH_CLIENT_ID &&
      config.OAUTH_CLIENT_SECRET &&
      config.OAUTH_TENANT_ID &&
      config.OAUTH_REFRESH_TOKEN
    );
  }

  /**
   * Get a valid access token (cached or refreshed)
   */
  async getAccessToken(): Promise<string> {
    if (!this.isOAuth2Configured()) {
      throw new Error('OAuth2 not configured. Please provide OAUTH_* environment variables.');
    }

    // If we have a cached token that's still valid (with 5 min buffer), return it
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
      logger.debug('Using cached OAuth2 access token');
      return this.cachedToken.accessToken;
    }

    // If a refresh is already in progress, wait for it
    if (this.refreshPromise) {
      logger.debug('Waiting for in-progress token refresh');
      return this.refreshPromise;
    }

    // Start a new refresh
    this.refreshPromise = this.refreshAccessToken();

    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Refresh the access token using the refresh token
   */
  private async refreshAccessToken(): Promise<string> {
    logger.info('Refreshing OAuth2 access token...');

    const tokenUrl = `https://login.microsoftonline.com/${config.OAUTH_TENANT_ID}/oauth2/v2.0/token`;

    const body = new URLSearchParams();
    body.append('client_id', config.OAUTH_CLIENT_ID!);
    body.append('client_secret', config.OAUTH_CLIENT_SECRET!);
    body.append('refresh_token', config.OAUTH_REFRESH_TOKEN!);
    body.append('grant_type', 'refresh_token');
    body.append('scope', [
      'https://outlook.office365.com/IMAP.AccessAsUser.All',
      'https://outlook.office365.com/SMTP.Send',
      'offline_access'
    ].join(' '));

    try {
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: body
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ error: errorText }, 'OAuth2 token refresh failed');
        throw new Error(`Token refresh failed: ${errorText}`);
      }

      const tokenData = await response.json() as TokenResponse;

      // Cache the new token (expires_in is in seconds)
      this.cachedToken = {
        accessToken: tokenData.access_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000
      };

      logger.info({
        expiresIn: tokenData.expires_in,
        expiresAt: new Date(this.cachedToken.expiresAt).toISOString()
      }, 'OAuth2 access token refreshed successfully');

      return tokenData.access_token;
    } catch (error) {
      logger.error({ error }, 'Failed to refresh OAuth2 access token');
      throw error;
    }
  }

  /**
   * Clear cached token (useful for testing or forcing refresh)
   */
  clearCache(): void {
    this.cachedToken = null;
    logger.debug('OAuth2 token cache cleared');
  }
}

// Singleton instance
export const oauth2Service = new OAuth2Service();

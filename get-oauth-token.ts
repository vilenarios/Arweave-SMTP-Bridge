/**
 * OAuth2 Token Generator for Microsoft 365
 * Run this once to get a refresh token
 */

import readline from 'readline';

const CLIENT_ID = 'c1655696-2322-4fea-985c-2748a611c650';
const TENANT_ID = '5a738dd0-40ca-461c-b7ed-dd8175841144';
const EMAIL_ADDRESS = 'preserve@ardrive.io';

const SCOPES = [
  'https://outlook.office365.com/IMAP.AccessAsUser.All',
  'https://outlook.office365.com/SMTP.Send',
  'offline_access'
];

async function getAuthorizationCode() {
  const authUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=http://localhost` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent(SCOPES.join(' '))}` +
    `&login_hint=${EMAIL_ADDRESS}`;

  console.log('\n========================================');
  console.log('Step 1: Get Authorization Code');
  console.log('========================================\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(authUrl);
  console.log('\n2. Sign in as preserve@ardrive.io');
  console.log('3. Accept the permissions');
  console.log('4. You will be redirected to localhost (will fail - that\'s OK!)');
  console.log('5. Copy the FULL URL from your browser address bar');
  console.log('\nIt will look like:');
  console.log('http://localhost/?code=M.R3_BAY.abc123...\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise<string>((resolve) => {
    rl.question('Paste the full redirect URL here: ', (url) => {
      rl.close();
      const code = new URL(url).searchParams.get('code');
      if (!code) {
        throw new Error('No code found in URL');
      }
      resolve(code);
    });
  });
}

async function exchangeCodeForTokens(code: string, clientSecret: string) {
  console.log('\n========================================');
  console.log('Step 2: Exchange Code for Tokens');
  console.log('========================================\n');

  const tokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: clientSecret,
    code: code,
    redirect_uri: 'http://localhost',
    grant_type: 'authorization_code',
    scope: SCOPES.join(' ')
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return await response.json();
}

async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║  Microsoft 365 OAuth2 Token Generator ║');
  console.log('╚════════════════════════════════════════╝\n');

  if (CLIENT_ID === 'YOUR_CLIENT_ID_HERE' || TENANT_ID === 'YOUR_TENANT_ID_HERE') {
    console.error('❌ ERROR: Please update CLIENT_ID and TENANT_ID in this script first!\n');
    console.log('You need to:');
    console.log('1. Copy your Client ID from Azure app registration');
    console.log('2. Copy your Tenant ID from Azure app registration');
    console.log('3. Update the variables at the top of this file\n');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const clientSecret = await new Promise<string>((resolve) => {
    rl.question('Enter your Client Secret: ', (secret) => {
      rl.close();
      resolve(secret);
    });
  });

  try {
    // Step 1: Get authorization code
    const code = await getAuthorizationCode();
    console.log('\n✅ Authorization code received!\n');

    // Step 2: Exchange for tokens
    const tokens = await exchangeCodeForTokens(code, clientSecret);

    console.log('\n✅ SUCCESS! Tokens received!\n');
    console.log('========================================');
    console.log('Add these to your .env file:');
    console.log('========================================\n');
    console.log('# OAuth2 Configuration');
    console.log(`OAUTH_CLIENT_ID="${CLIENT_ID}"`);
    console.log(`OAUTH_CLIENT_SECRET="${clientSecret}"`);
    console.log(`OAUTH_TENANT_ID="${TENANT_ID}"`);
    console.log(`OAUTH_REFRESH_TOKEN="${tokens.refresh_token}"`);
    console.log('');
    console.log('========================================');
    console.log('Access Token (for testing):');
    console.log('========================================');
    console.log(`${tokens.access_token.substring(0, 50)}...`);
    console.log(`\nExpires in: ${tokens.expires_in} seconds (${Math.floor(tokens.expires_in / 60)} minutes)`);
    console.log('\nThe refresh token will be used to automatically get new access tokens.\n');

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

main();

import 'dotenv/config';
import { handleIncomingEmails } from './src/services/email-upload';

console.log('Arweave SMTP Bridge');
console.log('-------------------');
console.log('Starting email monitoring service...');

// Make sure required environment variables are set
const requiredEnvVars = ['EMAIL_USER', 'EMAIL_PASSWORD'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

// Check for either ARWEAVE_JWK or ARWEAVE_JWK_PATH
if (!process.env.ARWEAVE_JWK && !process.env.ARWEAVE_JWK_PATH) {
  missingEnvVars.push('ARWEAVE_JWK or ARWEAVE_JWK_PATH');
}

if (missingEnvVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Please create a .env file with these variables or set them in your environment.');
  process.exit(1);
}

// Start the email monitoring service
handleIncomingEmails().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 
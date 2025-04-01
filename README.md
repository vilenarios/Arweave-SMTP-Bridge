# Arweave SMTP Bridge

An email-based bridge that automatically uploads attachments to Arweave using Turbo, then sends back a confirmation email with the transaction ID.

## Features

- Monitor an email inbox for new messages with attachments
- Automatically upload attachments to Arweave network via Turbo
- Send confirmation emails with transaction IDs
- Handle errors and file size restrictions gracefully
- Support for free tier uploads (up to 100MB)
- Subject line filtering to prevent accidental uploads

## Requirements

- Node.js 16+ or Bun 1.0+
- Gmail account (or other email provider with IMAP support)
- Arweave wallet with JWK
- For Gmail, you'll need to create an "App Password" for this application

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/arweave-smtp-bridge.git
   cd arweave-smtp-bridge
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Copy the example environment file and edit it with your details:
   ```bash
   cp .env.example .env
   ```

4. Edit the `.env` file with your email credentials and Arweave JWK:
   ```
   # Required: Email credentials
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASSWORD=your-app-specific-password
   
   # Option 1: Directly include JWK as JSON string
   ARWEAVE_JWK={"kty":"RSA","e":"AQAB",...}
   
   # OR Option 2 (Recommended): Provide path to JWK file
   ARWEAVE_JWK_PATH=./path/to/your/wallet.json
   ```

## Usage

Start the application:

```bash
bun start
```

The application will monitor your email inbox for new messages. When a message with an attachment is received:

1. The subject line is checked for the keyword "arweave" (case insensitive)
2. If the keyword is present, the attachment will be uploaded to Arweave via Turbo
3. A confirmation email with the transaction ID will be sent to the sender
4. The original email will be marked as read

## How to Use

1. Send an email with an attachment to the email address configured in the `.env` file
2. **Important:** Include the word "arweave" in the subject line (e.g., "Please upload to arweave")
3. The file will be automatically uploaded to Arweave 
4. You'll receive a confirmation email with the transaction ID and a link to view the file

## JWK Configuration

You have two options for configuring your Arweave wallet:

1. **Direct JWK in environment variable (less secure)**:
   ```
   ARWEAVE_JWK={"kty":"RSA","e":"AQAB",...}
   ```

2. **Path to JWK file (recommended)**:
   ```
   ARWEAVE_JWK_PATH=./path/to/your/wallet.json
   ```
   
   This is the recommended approach as it:
   - Keeps your private key out of environment variables
   - Avoids JWK escaping issues in the .env file
   - Improves security by keeping the wallet file separate
   - Makes it easier to use the same wallet across multiple environments

## Gmail App Password Setup

To use this with Gmail, you'll need to create an App Password:

1. Go to your Google Account settings
2. Navigate to "Security" > "2-Step Verification"
3. Scroll down to "App passwords"
4. Select "Mail" as the app and "Other" as the device
5. Give it a name like "Arweave SMTP Bridge"
6. Copy the generated password and use it in your `.env` file

## Error Handling

The application handles various error cases:

- **Size Exceeded**: For files larger than 100MB, a notification is sent to the sender
- **Upload Errors**: If there's an error during the upload process, an error notification is sent to the sender
- **Connection Issues**: The application logs connection issues with IMAP/SMTP
- **Subject Line Filtering**: Emails without "arweave" in the subject are skipped

## Customizing the Subject Filter

The default required keyword is "arweave". You can change this by modifying the `REQUIRED_SUBJECT_KEYWORD` constant in `src/services/email-upload.ts`.

## Running in Production

For production use, consider:

1. Using a process manager like PM2:
   ```bash
   npm install -g pm2
   pm2 start bun --name "arweave-smtp-bridge" -- run index.ts
   ```

2. Setting up proper logging:
   ```bash
   pm2 logs arweave-smtp-bridge
   ```

## License

MIT

## Acknowledgments

- ArDrive team for the Turbo SDK
- Arweave ecosystem for permanent storage 
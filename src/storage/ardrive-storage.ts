import path from 'path';
import { readFileSync } from 'fs';
import {
  arDriveFactory,
  JWKWallet,
  deriveDriveKey,
  ArDriveUploadStats,
  EID,
  wrapFileOrFolder,
  DriveKey,
  FileNameConflictResolution,
  ArFSEntityData
} from 'ardrive-core-js';
import { createLogger } from '../config/logger';
import { config } from '../config/env';

const logger = createLogger('ardrive-storage');

export interface FileToUpload {
  filepath: string;
  filename: string;
  contentType?: string;
}

export interface UploadResult {
  entityId: string;
  dataTxId?: string;
  fileKey?: string; // For private uploads
  fileName: string;
}

export interface FolderResult {
  folderId: string;
  folderKey?: string; // For private folders
}

/**
 * Upload files to ArDrive using Turbo
 * Creates drive and folder if they don't exist
 */
export async function uploadFilesToArDrive(
  userId: string,
  files: FileToUpload[],
  options: {
    driveId?: string;
    rootFolderId?: string;
    drivePassword?: string;
    driveName?: string;
  }
): Promise<{
  results: UploadResult[];
  driveId: string;
  rootFolderId: string;
  driveKeyBase64?: string; // Actual drive key from creation (for private drives)
}> {
  // Allow empty files array for drive creation only
  if (files.length === 0 && options.driveId) {
    throw new Error('No files provided for upload to existing drive');
  }

  // Load wallet
  const jwk = JSON.parse(readFileSync(config.ARWEAVE_JWK_PATH, 'utf-8'));
  const jwkWallet = new JWKWallet(jwk);

  // Create ArDrive instance with Turbo enabled (default settings)
  const arDrive = arDriveFactory({
    wallet: jwkWallet,
    turboSettings: {} // Use default Turbo settings
  });

  logger.info({ userId, fileCount: files.length }, 'Starting ArDrive upload');

  let { driveId, rootFolderId, drivePassword, driveName } = options;
  const isPrivate = !!drivePassword;
  let actualDriveKeyBase64: string | undefined;

  // Create drive if doesn't exist
  if (!driveId) {
    const driveName = options.driveName || `${userId}-private`;

    if (isPrivate && drivePassword) {
      // Create private drive
      logger.info({ userId, driveName }, 'Creating private drive');

      const walletPrivateKey = jwkWallet.getPrivateKey();
      const { PrivateDriveKeyData } = await import('ardrive-core-js');
      const newPrivateDriveData = await PrivateDriveKeyData.from(
        drivePassword,
        walletPrivateKey
      );

      // Extract the ACTUAL drive key from the creation data
      const actualDriveKey = (newPrivateDriveData as any).driveKey;
      if (actualDriveKey && actualDriveKey.keyData) {
        actualDriveKeyBase64 = actualDriveKey.keyData.toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
        logger.info({ userId, driveKeyPreview: actualDriveKeyBase64.substring(0, 20) }, 'Extracted actual drive key from creation');
      }

      const driveResult = await arDrive.createPrivateDrive({
        driveName,
        newPrivateDriveData
      });

      driveId = driveResult.created[0].entityId.toString();
      rootFolderId = driveResult.created[1].entityId.toString();

      logger.info({ userId, driveId, rootFolderId }, 'Created private drive');
    } else {
      // Create public drive
      logger.info({ userId, driveName }, 'Creating public drive');

      const driveResult = await arDrive.createPublicDrive({
        driveName: driveName
      });

      driveId = driveResult.created[0].entityId.toString();
      rootFolderId = driveResult.created[1].entityId.toString();

      logger.info({ userId, driveId, rootFolderId }, 'Created public drive');
    }
  }

  // Derive drive key for private drives
  let driveKey: DriveKey | undefined;
  if (isPrivate && drivePassword) {
    driveKey = await deriveDriveKey(
      drivePassword,
      driveId,
      JSON.stringify(jwkWallet.getPrivateKey())
    );
  }

  // If no files, return early (drive was created, that's all we needed)
  if (files.length === 0) {
    logger.info({ userId, driveId, rootFolderId }, 'Drive created, no files to upload');
    return {
      results: [],
      driveId,
      rootFolderId,
      driveKeyBase64: actualDriveKeyBase64
    };
  }

  // Prepare files for upload
  const entitiesToUpload: ArDriveUploadStats[] = [];
  const destFolderId = EID(rootFolderId);

  for (const file of files) {
    const filepath = path.resolve(file.filepath);
    const filename = file.filename || path.basename(filepath);

    // Pass content-type to wrapFileOrFolder for proper MIME type tagging
    const wrapped = await wrapFileOrFolder(
      filepath,
      file.contentType || 'application/octet-stream'
    );

    const entity: ArDriveUploadStats = {
      wrappedEntity: wrapped,
      destFolderId,
      destName: filename,
      ...(isPrivate && driveKey ? { driveKey } : {})
    };

    entitiesToUpload.push(entity);
  }

  logger.info({
    userId,
    driveId,
    rootFolderId,
    fileCount: files.length,
    isPrivate
  }, 'Uploading files to ArDrive');

  // Upload all files
  const uploadResult = await arDrive.uploadAllEntities({
    entitiesToUpload,
    conflictResolution: 'OVERWRITE' as FileNameConflictResolution
  });

  // Log upload result for debugging
  logger.info({
    userId,
    createdCount: uploadResult.created?.length || 0,
    uploadResultKeys: Object.keys(uploadResult),
    entities: uploadResult.created?.map((e: any) => ({
      type: e.type || e.constructor?.name || 'unknown',
      hasEntityId: !!e.entityId,
      hasDataTxId: !!e.dataTxId,
      keys: Object.keys(e).slice(0, 10) // First 10 keys
    }))
  }, 'Upload result received');

  // Check if upload actually created any entities
  if (!uploadResult.created || uploadResult.created.length === 0) {
    logger.error({
      userId,
      uploadResult: JSON.stringify(uploadResult, null, 2)
    }, 'Upload succeeded but no entities were created');
    throw new Error('Upload succeeded but no entities were created');
  }

  // Map results - ArDrive returns multiple entities per file (metadata + data txs)
  // We need to extract only the file entities and match them to our uploaded files
  const results: UploadResult[] = [];
  let fileIndex = 0;

  for (const entity of uploadResult.created) {
    // Skip if we've already processed all our files
    if (fileIndex >= files.length) break;

    // File entities have entityId (which is the file ID in ArDrive)
    if (entity.entityId) {
      // Convert file key to base64url format (URL-safe)
      let fileKey: string | undefined;
      if (isPrivate && entity.key) {
        const keyBase64 = entity.key.toString();
        fileKey = keyBase64
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
      }

      results.push({
        entityId: entity.entityId.toString(),
        dataTxId: entity.dataTxId?.toString(),
        fileKey,
        fileName: files[fileIndex]?.filename || 'unknown'
      });
      fileIndex++;
    }
  }

  logger.info({
    userId,
    uploadedCount: results.length,
    driveId,
    isPrivate
  }, 'Successfully uploaded files to ArDrive');

  return {
    results,
    driveId,
    rootFolderId,
    driveKeyBase64: actualDriveKeyBase64
  };
}

/**
 * Create a folder in an existing ArDrive
 * @param userJwk - Optional user wallet (if not provided, uses master wallet)
 */
export async function createFolderInDrive(
  driveId: string,
  folderName: string,
  parentFolderId: string,
  drivePassword?: string,
  userJwk?: object
): Promise<FolderResult> {
  const jwk = userJwk || JSON.parse(readFileSync(config.ARWEAVE_JWK_PATH, 'utf-8'));
  const jwkWallet = new JWKWallet(jwk);

  const arDrive = arDriveFactory({
    wallet: jwkWallet,
    turboSettings: {}
  });

  const isPrivate = !!drivePassword;

  logger.info({ driveId, folderName, parentFolderId, isPrivate }, 'Creating folder in drive');

  if (isPrivate && drivePassword) {
    // Derive drive key for private folder
    const driveKey = await deriveDriveKey(
      drivePassword,
      driveId,
      JSON.stringify(jwkWallet.getPrivateKey())
    );

    const result = await arDrive.createPrivateFolder({
      folderName,
      driveId: EID(driveId),
      parentFolderId: EID(parentFolderId),
      driveKey
    });

    const folderId = result.created[0].entityId.toString();
    const folderKey = result.created[0].key?.toString();

    logger.info({ folderId, folderKey: !!folderKey }, 'Created private folder');

    return { folderId, folderKey };
  } else {
    // Public folder
    const result = await arDrive.createPublicFolder({
      folderName,
      driveId: EID(driveId),
      parentFolderId: EID(parentFolderId)
    });

    const folderId = result.created[0].entityId.toString();

    logger.info({ folderId }, 'Created public folder');

    return { folderId };
  }
}

/**
 * Derive drive key for sharing URLs
 */
export async function getDriveShareKey(
  driveId: string,
  drivePassword: string
): Promise<string> {
  const jwk = JSON.parse(readFileSync(config.ARWEAVE_JWK_PATH, 'utf-8'));
  const jwkWallet = new JWKWallet(jwk);

  const driveKey = await deriveDriveKey(
    drivePassword,
    driveId,
    JSON.stringify(jwkWallet.getPrivateKey())
  );

  // Extract keyData buffer and convert to base64url format (URL-safe)
  // Use .keyData.toString('base64') just like ArDrive does for file keys
  const driveKeyBase64 = driveKey.keyData.toString('base64');
  const driveKeyBase64Url = driveKeyBase64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  logger.info({ driveId, base64: driveKeyBase64.substring(0, 20), base64url: driveKeyBase64Url.substring(0, 20) }, 'Derived drive share key');

  return driveKeyBase64Url;
}

/**
 * Upload multiple files to a specific folder in ArDrive using Turbo batching
 * This is more efficient than uploading files one-by-one
 * @param userJwk - Optional user wallet (if not provided, uses master wallet)
 */
export async function uploadFilesToFolder(
  driveId: string,
  folderId: string,
  files: Array<{ filepath: string; filename: string; contentType?: string }>,
  drivePassword?: string,
  userJwk?: object
): Promise<UploadResult[]> {
  if (files.length === 0) {
    return [];
  }

  const jwk = userJwk || JSON.parse(readFileSync(config.ARWEAVE_JWK_PATH, 'utf-8'));
  const jwkWallet = new JWKWallet(jwk);

  const arDrive = arDriveFactory({
    wallet: jwkWallet,
    turboSettings: {}
  });

  const isPrivate = !!drivePassword;
  const destFolderId = EID(folderId);

  // Derive drive key for private uploads
  let driveKey: DriveKey | undefined;
  if (isPrivate && drivePassword) {
    driveKey = await deriveDriveKey(
      drivePassword,
      driveId,
      JSON.stringify(jwkWallet.getPrivateKey())
    );
  }

  // Prepare all files for batch upload
  const entitiesToUpload: ArDriveUploadStats[] = [];

  for (const file of files) {
    const resolvedPath = path.resolve(file.filepath);

    // Pass content-type to wrapFileOrFolder for proper MIME type tagging
    const wrapped = await wrapFileOrFolder(
      resolvedPath,
      file.contentType || 'application/octet-stream' // Default to octet-stream if not specified
    );

    const entity: ArDriveUploadStats = {
      wrappedEntity: wrapped,
      destFolderId,
      destName: file.filename,
      ...(isPrivate && driveKey ? { driveKey } : {})
    };

    entitiesToUpload.push(entity);
  }

  logger.info({
    driveId,
    folderId,
    fileCount: files.length,
    isPrivate
  }, 'Batch uploading files to folder');

  // Upload ALL files in one Turbo transaction (bundled)
  const uploadResult = await arDrive.uploadAllEntities({
    entitiesToUpload,
    conflictResolution: 'OVERWRITE' as FileNameConflictResolution
  });

  if (!uploadResult.created || uploadResult.created.length === 0) {
    throw new Error('Batch upload succeeded but no entities were created');
  }

  // Extract file entities
  const results: UploadResult[] = [];
  let fileIndex = 0;

  for (const entity of uploadResult.created) {
    if (fileIndex >= files.length) break;

    if (entity.entityId) {
      // Convert file key to base64url format (URL-safe)
      let fileKey: string | undefined;
      if (isPrivate && entity.key) {
        const keyBase64 = entity.key.toString();
        fileKey = keyBase64
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
      }

      results.push({
        entityId: entity.entityId.toString(),
        dataTxId: entity.dataTxId?.toString(),
        fileKey,
        fileName: files[fileIndex]?.filename || 'unknown'
      });
      fileIndex++;
    }
  }

  logger.info({
    uploadedCount: results.length,
    driveId,
    folderId
  }, 'Batch upload complete');

  return results;
}

/**
 * Upload a single file to a specific folder in ArDrive
 * NOTE: For multiple files, use uploadFilesToFolder for better Turbo batching
 * @param userJwk - Optional user wallet (if not provided, uses master wallet)
 */
export async function uploadFileToFolder(
  driveId: string,
  folderId: string,
  filepath: string,
  filename: string,
  drivePassword?: string,
  userJwk?: object
): Promise<UploadResult> {
  // Use batch function with single file
  const results = await uploadFilesToFolder(
    driveId,
    folderId,
    [{ filepath, filename }],
    drivePassword,
    userJwk
  );

  if (results.length === 0) {
    throw new Error('Upload failed - no results returned');
  }

  return results[0];
}

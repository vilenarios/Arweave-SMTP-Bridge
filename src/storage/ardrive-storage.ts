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
      rootFolderId
    };
  }

  // Prepare files for upload
  const entitiesToUpload: ArDriveUploadStats[] = [];
  const destFolderId = EID(rootFolderId);

  for (const file of files) {
    const filepath = path.resolve(file.filepath);
    const filename = file.filename || path.basename(filepath);
    const wrapped = await wrapFileOrFolder(filepath);

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
      results.push({
        entityId: entity.entityId.toString(),
        dataTxId: entity.dataTxId?.toString(),
        fileKey: isPrivate ? entity.key?.toString() : undefined,
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
    rootFolderId
  };
}

/**
 * Create a folder in an existing ArDrive
 */
export async function createFolderInDrive(
  driveId: string,
  folderName: string,
  parentFolderId: string,
  drivePassword?: string
): Promise<FolderResult> {
  const jwk = JSON.parse(readFileSync(config.ARWEAVE_JWK_PATH, 'utf-8'));
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

  // Convert drive key to base64 for URL
  const driveKeyBase64 = Buffer.from(JSON.stringify(driveKey)).toString('base64');

  logger.info({ driveId }, 'Derived drive share key');

  return driveKeyBase64;
}

/**
 * Upload a single file to a specific folder in ArDrive
 */
export async function uploadFileToFolder(
  driveId: string,
  folderId: string,
  filepath: string,
  filename: string,
  drivePassword?: string
): Promise<UploadResult> {
  const jwk = JSON.parse(readFileSync(config.ARWEAVE_JWK_PATH, 'utf-8'));
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

  // Prepare file for upload
  const resolvedPath = path.resolve(filepath);
  const wrapped = await wrapFileOrFolder(resolvedPath);

  const entity: ArDriveUploadStats = {
    wrappedEntity: wrapped,
    destFolderId,
    destName: filename,
    ...(isPrivate && driveKey ? { driveKey } : {})
  };

  logger.info({
    driveId,
    folderId,
    filename,
    isPrivate
  }, 'Uploading file to folder');

  // Upload file
  const uploadResult = await arDrive.uploadAllEntities({
    entitiesToUpload: [entity],
    conflictResolution: 'OVERWRITE' as FileNameConflictResolution
  });

  if (!uploadResult.created || uploadResult.created.length === 0) {
    throw new Error('Upload succeeded but no entities were created');
  }

  // Extract file entity (first entity with entityId)
  const fileEntity = uploadResult.created.find(e => e.entityId);
  if (!fileEntity) {
    throw new Error('Could not find file entity in upload result');
  }

  const result: UploadResult = {
    entityId: fileEntity.entityId.toString(),
    dataTxId: fileEntity.dataTxId?.toString(),
    fileKey: isPrivate ? fileEntity.key?.toString() : undefined,
    fileName: filename
  };

  logger.info({
    entityId: result.entityId,
    dataTxId: result.dataTxId,
    hasFileKey: !!result.fileKey
  }, 'File uploaded successfully');

  return result;
}

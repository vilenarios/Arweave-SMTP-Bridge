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
  if (files.length === 0) {
    throw new Error('No files provided for upload');
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

  // Map results
  const results: UploadResult[] = uploadResult.created.map((entity, index) => ({
    entityId: entity.entityId.toString(),
    dataTxId: entity.dataTxId?.toString(),
    fileKey: isPrivate ? entity.key?.toString() : undefined,
    fileName: files[index]?.filename || 'unknown'
  }));

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

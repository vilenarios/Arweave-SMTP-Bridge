import path from 'path';
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

export interface PreparedEmailFile {
  filepath: string;
  filename: string;
  contentType?: string;
}

export interface ArDriveUploadContext {
  wallet: any;                // JWK
  driveId: string;            // Needed only for private
  rootFolderId: string;       // Folder to upload into
  drivePassword?: string;     // Only for private drives
  tags?: { name: string; value: string }[];
}

export async function uploadToArDrive(
  context: ArDriveUploadContext,
  files: PreparedEmailFile[]
): Promise<ArFSEntityData[]> {
  const { wallet, driveId, rootFolderId, drivePassword, tags = [] } = context;

  const jwkWallet = new JWKWallet(wallet);
  const arDrive = arDriveFactory({ wallet: jwkWallet, turboSettings: {} });

  const destFolderId = EID(rootFolderId);
  const isPrivate = !!drivePassword;

  let driveKey: DriveKey | undefined;
  if (isPrivate) {
    driveKey = await deriveDriveKey(
      drivePassword!,
      driveId,
      JSON.stringify(jwkWallet.getPrivateKey())
    );
  }

  const entitiesToUpload: ArDriveUploadStats[] = [];

  if (!files.length) {
    console.warn('[ForwARd:ardrive-upload] No files provided for upload.');
    return [];
  }

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

  console.log(`[ForwARd:ardrive-upload] Uploading to ${isPrivate ? 'private' : 'public'} drive`);
  console.log(`→ Drive ID: ${driveId}`);
  console.log(`→ Folder ID: ${rootFolderId}`);

  const result = await arDrive.uploadAllEntities({
    entitiesToUpload,
    conflictResolution: 'OVERWRITE' as FileNameConflictResolution
  });

  const uploadedIds = result.created.map(r => r.entityId);
  console.log(`[ForwARd:ardrive-upload] Uploaded ${uploadedIds.length} file(s) to ${isPrivate ? 'private' : 'public'} drive`);
  return result.created;
}

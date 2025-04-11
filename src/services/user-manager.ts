import { arDriveFactory, JWKWallet, PrivateDriveKeyData } from 'ardrive-core-js';
import Arweave from 'arweave';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { decrypt, encrypt, generatePrivateDrivePassword, hashEmail } from './crypto';

const GQL_URL = 'https://arweave.net/graphql';
const SYSTEM_SECRET = process.env.FORWARD_ENCRYPTION_SECRET || 'change-me';
const userStorePath = join(__dirname, '../../user-store/users.json');

// UTILS
function loadUserStore(): Record<string, any> {
  if (!existsSync(userStorePath)) writeFileSync(userStorePath, JSON.stringify({}, null, 2));
  return JSON.parse(readFileSync(userStorePath, 'utf-8'));
}

function saveUserStore(store: Record<string, any>) {
  writeFileSync(userStorePath, JSON.stringify(store, null, 2));
}

interface InitUserOptions {
  needsPublic?: boolean;
  needsPrivate?: boolean;
}

// MAIN
export async function initUser(email: string, options: InitUserOptions = {}) {
  const { needsPublic = false, needsPrivate = false } = options;
  const store = loadUserStore();
  const id = hashEmail(email);
  const arweave = Arweave.init({});

  let userEntry = store[id];
  let wallet: any;
  let isNewWallet = false;

  try {
    if (userEntry) {
      wallet = JSON.parse(decrypt(userEntry.wallet, SYSTEM_SECRET));
    } else {
      wallet = await arweave.wallets.generate();
      userEntry = {
        email,
        wallet: encrypt(JSON.stringify(wallet), SYSTEM_SECRET),
        walletInitialized: true
      };
      store[id] = userEntry;
      saveUserStore(store); // Save early to prevent duplicate wallets
      isNewWallet = true;
    }

    // const jwkWallet = new JWKWallet(wallet); // Use the email sender's wallet
    // const arDrive = arDriveFactory({ wallet: jwkWallet });
    const mainJWK = JSON.parse(readFileSync(process.env.ARWEAVE_JWK_PATH || './wallet.json', 'utf-8'));
    const jwkWallet = new JWKWallet(mainJWK); // Use the main wallet
    const mainAddress = await arweave.wallets.jwkToAddress(mainJWK);
    console.log(`[ForwARd] Using main wallet ${mainAddress}`);
    const arDrive = arDriveFactory({ wallet: jwkWallet, turboSettings: {} });

    if (isNewWallet) {
      const newAddress = await arweave.wallets.jwkToAddress(wallet);
      console.log(`[ForwARd] Created wallet for ${email}: ${newAddress}`);
    
      // ADD THIS BACK WHEN CREDIT SHARING WORKS!
      /*try {
        // Dynamically fund wallet with Turbo credits
        const mainJWK = JSON.parse(readFileSync(process.env.ARWEAVE_JWK_PATH || './wallet.json', 'utf-8'));
    
        const signer = new ArweaveSigner(mainJWK);
        const turbo = TurboFactory.authenticated({ signer });
        const { winc: mainWalletBalance } = await turbo.getBalance();
        const mainAddress = await arweave.wallets.jwkToAddress(mainJWK);

        console.log(`[ForwARd] Main wallet ${mainAddress} balance: ${mainWalletBalance}`);

        const APPROVED_AMOUNT = 10000000000;
        console.log(`[ForwARd] Sharing ${APPROVED_AMOUNT} Turbo credits to ${newAddress}`);

        const { approvalDataItemId } = await turbo.shareCredits({
          approvedAddress: newAddress,
          approvedWincAmount: APPROVED_AMOUNT,
          expiresBySeconds: 3600 * 24 * 1 // one day for testing
        });
    
        console.log(`[ForwARd] Shared ${APPROVED_AMOUNT} Turbo credits to ${newAddress} (TX: ${approvalDataItemId})`);
      } catch (creditErr) {
        console.warn(`[ForwARd] ⚠️ Failed to share Turbo credits with ${email}:`, creditErr.message);
        // Optional: track failed fundings in a separate file or alerting system
      } */
    }

    // Create drives if needed
    if (!userEntry) userEntry = { email, wallet: encrypt(JSON.stringify(wallet), SYSTEM_SECRET) };

    if (needsPublic && !userEntry.publicDriveId) {
      const publicDriveName = `${email}-Public`;
      const publicDriveResult = await arDrive.createPublicDrive({ driveName: publicDriveName });
      userEntry.publicDriveId = publicDriveResult.created[0].entityId;
      userEntry.publicDriveRootFolderId = publicDriveResult.created[1].entityId;
      console.log(`[ForwARd:user-store] Created public drive for ${email}`);
    }

    if (needsPrivate && !userEntry.privateDriveId) {
      const privateDriveName = `${email}-Private`;
      const privateDrivePassword = generatePrivateDrivePassword();
      const walletPrivateKey = jwkWallet.getPrivateKey();
      const newPrivateDriveData = await PrivateDriveKeyData.from(privateDrivePassword, walletPrivateKey);
      await arDrive.assertValidPassword(privateDrivePassword);
      const privateDriveResult = await arDrive.createPrivateDrive({
        driveName: privateDriveName,
        newPrivateDriveData
      });
      userEntry.privateDriveId = privateDriveResult.created[0].entityId;
      userEntry.privateDriveRootFolderId = privateDriveResult.created[1].entityId;
      userEntry.privateDrivePassword = encrypt(privateDrivePassword, SYSTEM_SECRET);
      console.log(`[ForwARd:user-store] Created private drive for ${email}`);
    }

    // Only persist once everything has succeeded
    store[id] = userEntry;
    saveUserStore(store);

    if (needsPublic && !userEntry.publicDriveId) {
      await waitForDriveToBeIndexed(mainAddress, userEntry.publicDriveId);
      await waitForFolderToBeIndexed(mainAddress, userEntry.publicDriveRootFolderId);
    }
    
    if (needsPrivate && !userEntry.privateDriveId) {
      await waitForDriveToBeIndexed(mainAddress, userEntry.privateDriveId);
      await waitForFolderToBeIndexed(mainAddress, userEntry.privateDriveRootFolderId);
    }

    return {
      wallet,
      publicDriveId: userEntry.publicDriveId,
      publicDriveRootFolderId: userEntry.publicDriveRootFolderId,
      privateDriveId: userEntry.privateDriveId,
      privateDriveRootFolderId: userEntry.privateDriveRootFolderId,
      privateDrivePassword: userEntry.privateDrivePassword
        ? decrypt(userEntry.privateDrivePassword, SYSTEM_SECRET)
        : undefined
    };
  } catch (err) {
    console.error(`[ForwARd:initUser] Error creating user ${email}:`, err);
    throw err; // Don't persist partial state
  }
}

export async function waitForDriveToBeIndexed(owner: string, driveId: string, maxRetries = 10, delayMs = 30000): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const query = {
        query: `
        query {
          transactions(
          owners:[${owner}])
          tags: [
            { name: "Entity-Type", values: ["drive"] }
            { name: "Drive-Id", values: ["${driveId}"] }
          ]) {
            edges {
              node {
                id
                tags {
                  name
                  value
                }
              }
            }
          }
        }`
      };

      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query)
      });

      const data = await res.json();
      if (data.data.transactions.edges.length > 0) {
        console.log(`[ForwARd:waitForDrive] Drive ${driveId} indexed after ${attempt} attempt(s)`);
        return;
      }
    } catch (err) {
      console.warn(`[ForwARd:waitForDrive] Retry ${attempt} failed`, err);
    }

    await new Promise(res => setTimeout(res, delayMs));
  }

  throw new Error(`[ForwARd:waitForDrive] Drive ${driveId} not found after ${maxRetries} retries`);
}

export async function waitForFolderToBeIndexed(owner: string, folderId: string, maxRetries = 10, delayMs = 30000): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const query = {
        query: `
        query {
          transactions(
          owners:[${owner}])
          tags: [
            { name: "Entity-Type", values: ["folder"] }
            { name: "Folder-Id", values: ["${folderId}"] }
          ]) {
            edges {
              node {
                id
                tags {
                  name
                  value
                }
              }
            }
          }
        }`
      };

      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query)
      });

      const data = await res.json();
      if (data.data.transactions.edges.length > 0) {
        console.log(`[ForwARd:waitForFolder Folder ${folderId} indexed after ${attempt} attempt(s)`);
        return;
      }
    } catch (err) {
      console.warn(`[ForwARd:waitForFolder] Retry ${attempt} failed`, err);
    }

    await new Promise(res => setTimeout(res, delayMs));
  }

  throw new Error(`[ForwARd:waitForFolder] Folder ${folderId} not found after ${maxRetries} retries`);
}

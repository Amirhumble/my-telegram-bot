'use strict';

/**
 * One-time (or re-runnable) seed script.
 *
 * Uploads local Images/ and Documents/ to Telegram once,
 * then stores the returned file_id values in the resources table.
 *
 * After this runs successfully, the bot never reads local files at runtime.
 *
 * Usage:
 *   node scripts/seed-resources.js
 *
 * Requirements:
 *   - .env fully configured (including ADMIN_CHAT_ID as the upload target)
 *   - Local files present under Images/ and Documents/
 *   - SQL migration already applied in Supabase
 */

const path = require('path');
const fs = require('fs');

// Load env early
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// Validate via config (throws if missing)
const { ADMIN_CHAT_ID } = require('../src/config/env');
const telegram = require('../src/services/telegram');
const resourcesService = require('../src/services/resources');
const logger = require('../src/utils/logger');

const ROOT = path.resolve(__dirname, '..');

const RESOURCES = [
  {
    name: 'ders_program',
    type: 'image',
    localPath: path.join(ROOT, 'Images', 'ders_image.jpg'),
    caption: 'የደርስ ፕሮግራም',
    sortOrder: 1,
  },
  {
    name: 'mutemima',
    type: 'pdf',
    localPath: path.join(ROOT, 'Documents', 'mutemima.pdf'),
    caption: 'متممة الآجرومية',
    sortOrder: 1,
  },
  {
    name: 'ajerumiya',
    type: 'pdf',
    localPath: path.join(ROOT, 'Documents', 'ajerumiya.pdf'),
    caption: 'الآجرومية',
    sortOrder: 2,
  },
  {
    name: 'arbein',
    type: 'pdf',
    localPath: path.join(ROOT, 'Documents', 'arbein.pdf'),
    caption: 'الأربعون النووية',
    sortOrder: 3,
  },
  {
    name: 'riyad',
    type: 'pdf',
    localPath: path.join(ROOT, 'Documents', 'riyad.pdf'),
    caption: 'رياض الصالحين',
    sortOrder: 4,
  },
];

async function seedOne(resource) {
  if (!fs.existsSync(resource.localPath)) {
    logger.error('Local file missing — skip', {
      name: resource.name,
      path: resource.localPath,
    });
    return { name: resource.name, ok: false, reason: 'missing_file' };
  }

  // Skip if already seeded (unless FORCE_RESEED=1)
  if (process.env.FORCE_RESEED !== '1') {
    const existing = await resourcesService.getResourceByName(resource.name);
    if (existing?.telegram_file_id) {
      logger.info('Already seeded — skip', {
        name: resource.name,
        fileId: existing.telegram_file_id.slice(0, 20) + '…',
      });
      return { name: resource.name, ok: true, reason: 'already_exists', fileId: existing.telegram_file_id };
    }
  }

  logger.info('Uploading to Telegram…', { name: resource.name, type: resource.type });

  let fileId;

  if (resource.type === 'image') {
    fileId = await telegram.uploadPhotoFromPath(
      ADMIN_CHAT_ID,
      resource.localPath,
      `<b>${resource.caption}</b>`
    );
  } else {
    fileId = await telegram.uploadDocumentFromPath(
      ADMIN_CHAT_ID,
      resource.localPath,
      `<b>${resource.caption}</b>`
    );
  }

  if (!fileId) {
    logger.error('Upload returned no file_id', { name: resource.name });
    return { name: resource.name, ok: false, reason: 'no_file_id' };
  }

  await resourcesService.upsertResource({
    name: resource.name,
    type: resource.type,
    telegramFileId: fileId,
    caption: resource.caption,
    sortOrder: resource.sortOrder,
  });

  logger.info('Saved resource', { name: resource.name, fileId: fileId.slice(0, 24) + '…' });
  return { name: resource.name, ok: true, fileId };
}

async function main() {
  logger.info('=== Resource seed starting ===');
  logger.info('Upload target: admin chat (configured via ADMIN_CHAT_ID)');

  const results = [];

  for (const resource of RESOURCES) {
    try {
      const result = await seedOne(resource);
      results.push(result);
      // Be polite to Telegram rate limits
      await telegram.sleep(1500);
    } catch (err) {
      logger.error('Seed failed for resource', {
        name: resource.name,
        message: err.message,
        details: err.details,
      });
      results.push({ name: resource.name, ok: false, reason: err.message });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;

  logger.info('=== Seed complete ===', { ok, fail });
  console.table(
    results.map((r) => ({
      name: r.name,
      ok: r.ok,
      reason: r.reason || 'uploaded',
    }))
  );

  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal seed error:', err);
  process.exit(1);
});

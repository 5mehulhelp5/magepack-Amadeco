/**
 * @file lib/disable.js
 * @description Removes Magepack configurations from deployed static files and syncs SRI hashes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import consola from 'consola';

import { PATHS, FILES, MARKERS } from './utils/constants.js';
import getLocales from './bundle/getLocales.js';

const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Calculates the SRI hash (SHA-256) for a given file buffer.
 */
const generateSriHash = (buffer) => {
    const hash = createHash('sha256').update(buffer).digest('base64');
    return `sha256-${hash}`;
};

/**
 * Removes the Magepack injected configuration block from RequireJS config files.
 */
const cleanRequireConfig = async (localePath) => {
    const targets = [FILES.REQUIREJS_CONFIG, FILES.REQUIREJS_CONFIG_MIN];
    
    for (const fileName of targets) {
        const configPath = path.join(localePath, fileName);
        try {
            await fs.access(configPath);
            let content = await fs.readFile(configPath, 'utf8');
            
            // Regex to match the exact block injected by configInjector.js
            const cleanRegex = new RegExp(`\\n?${escapeRegExp(MARKERS.START)}[\\s\\S]*?${escapeRegExp(MARKERS.END)}`, 'g');
            
            if (cleanRegex.test(content)) {
                content = content.replace(cleanRegex, '');
                await fs.writeFile(configPath, content, 'utf8');
                consola.debug(`   Cleaned ${fileName}`);
            }
        } catch (e) {
            // File might not exist (e.g., .min.js in dev mode), gracefully ignore
        }
    }
};

/**
 * Deletes the generated magepack bundle directory.
 */
const deleteMagepackDir = async (localePath) => {
    const dirPath = path.join(localePath, PATHS.MAGEPACK_DIR);
    try {
        await fs.rm(dirPath, { recursive: true, force: true });
        consola.debug(`   Removed ${PATHS.MAGEPACK_DIR}/ directory`);
    } catch (e) {
        // Directory already gone or doesn't exist
    }
};

/**
 * Prunes Magepack bundles from the SRI hashes and updates the RequireJS config hashes.
 */
const syncSriHashes = async (locales) => {
    const rootPath = process.cwd();
    const sriPath = path.resolve(rootPath, PATHS.STATIC_FRONTEND, FILES.SRI_HASHES);

    try {
        await fs.access(sriPath);
    } catch {
        return; // No SRI file found, feature inactive
    }

    consola.start('🔐 Synchronizing SRI hashes...');
    let sriData = JSON.parse(await fs.readFile(sriPath, 'utf8'));
    let updated = false;

    // 1. Remove Magepack bundle hashes from the JSON
    for (const key of Object.keys(sriData)) {
        if (key.includes(`/${PATHS.MAGEPACK_DIR}/bundle-`)) {
            delete sriData[key];
            updated = true;
        }
    }

    // 2. Recalculate hashes for the cleaned RequireJS configs
    for (const locale of locales) {
        const localePathAbsolute = path.join(rootPath, PATHS.STATIC_FRONTEND, locale.vendor, locale.name, locale.code);
        const localeKey = [PATHS.FRONTEND, locale.vendor, locale.name, locale.code].join('/');

        for (const file of [FILES.REQUIREJS_CONFIG, FILES.REQUIREJS_CONFIG_MIN]) {
            const filePath = path.join(localePathAbsolute, file);
            const fileKey = `${localeKey}/${file}`;

            try {
                const buffer = await fs.readFile(filePath);
                const newHash = generateSriHash(buffer);
                if (sriData[fileKey] !== newHash) {
                    sriData[fileKey] = newHash;
                    updated = true;
                }
            } catch (e) {
                // Ignore missing files
            }
        }
    }

    if (updated) {
        await fs.writeFile(sriPath, JSON.stringify(sriData, null, 4));
        consola.success(`✅ Cleaned and synchronized ${FILES.SRI_HASHES}`);
    }
};

/**
 * Main command execution
 */
export default async () => {
    consola.info('🚀 Disabling Magepack and cleaning up static files...');
    
    try {
        const locales = await getLocales(process.cwd());

        for (const locale of locales) {
            const localePath = path.join(process.cwd(), PATHS.STATIC_FRONTEND, locale.vendor, locale.name, locale.code);
            const label = `${locale.vendor}/${locale.name} (${locale.code})`;
            
            consola.info(`Processing ${label}...`);
            await cleanRequireConfig(localePath);
            await deleteMagepackDir(localePath);
        }

        await syncSriHashes(locales);
        
        consola.success('✨ Magepack has been successfully disabled across all locales.');
        consola.info('💡 Note: You can re-enable it by running the `magepack bundle` command again.');
        
    } catch (e) {
        consola.error('❌ Failed to disable Magepack: ', e.message);
        process.exit(1);
    }
};

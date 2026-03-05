/**
 * @fileoverview File Compression Service for Magepack.
 * Handles the concurrent generation of Gzip (.gz), Brotli (.br), and native Zstandard (.zst).
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import consola from 'consola';

// Promisify execFile to use it with async/await
const execFileAsync = promisify(execFile);

/**
 * Cache for Zstd availability check to avoid running the shell command multiple times.
 * @type {boolean|null}
 */
let zstdCheck = null;

/**
 * Checks if the 'zstd' CLI tool is installed on the host OS.
 * @returns {Promise<boolean>}
 */
const checkZstdAvailability = () => {
    if (!zstdCheck) {
        zstdCheck = execFileAsync('zstd', ['--version'])
            .then(() => true)
            .catch(() => false);
    }
    return zstdCheck;
};

/**
 * Compresses a target file using Gzip, Brotli, and native Zstandard (Zstd).
 *
 * @async
 * @param {string} filePath - The absolute path to the generated JavaScript bundle file.
 * @param {Object} [options={}] - Configuration options for the compression process.
 * @param {boolean} [options.fastCompression=false] - If true, uses lower compression levels.
 * @returns {Promise<void>} 
 */
export const compressFile = async (filePath, options = {}) => {
    // 1. Gzip Pipeline (Native Node.js Stream)
    const gzipJob = pipeline(
        createReadStream(filePath),
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );
    
    // 2. Brotli Pipeline (Native Node.js Stream)
    const brotliQuality = options.fastCompression 
        ? constants.BROTLI_DEFAULT_QUALITY
        : constants.BROTLI_MAX_QUALITY;
  
    const brotliJob = pipeline(
        createReadStream(filePath),
        createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                [constants.BROTLI_PARAM_LGWIN]: 24, 
            },
        }),
        createWriteStream(`${filePath}.br`)
    );

    // 3. Zstandard Job (Native OS CLI)
    const zstdJob = async () => {
        // Step A: Check if the tool exists
        const hasZstd = await checkZstdAvailability();
        if (!hasZstd) {
            // We only log this once per build to avoid spamming the console
            if (zstdCheck === false) {
                consola.warn('⚠️ Native "zstd" CLI not found. Skipping .zst generation. To enable, please install it on your server (e.g., "sudo apt-get install zstd").');
                zstdCheck = 'warned'; // Prevent duplicate warnings
            }
            return; // Gracefully exit this specific job without failing the Promise.all
        }

        // Step B: Build arguments for maximum compression
        // We use level 3 for fast builds, and level 22 (Maximum) with --ultra for production.
        const zstdArgs = options.fastCompression
            ? ['-3', '--force', '--quiet', filePath, '-o', `${filePath}.zst`]
            : ['-22', '--ultra', '--force', '--quiet', filePath, '-o', `${filePath}.zst`];
        
        try {
            await execFileAsync('zstd', zstdArgs);
        } catch (error) {
            consola.error(`❌ Native Zstd compression failed for ${filePath}: ${error.message}`);
        }
    };
  
    // Execute all three tasks concurrently
    await Promise.all([gzipJob, brotliJob, zstdJob()]);
};

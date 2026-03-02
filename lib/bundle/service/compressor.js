import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ZstdStream } from '@oneidentity/zstd-js';

/**
 * Compresses a file using Gzip, Brotli, and Zstd in parallel via Streams.
 * This ensures low memory usage even for large bundles.
 *
 * @param {string} filePath - Absolute path to the file.
 * @param {Object} options - CLI options (fastCompression).
 * @returns {Promise<void>}
 */
export const compressFile = async (filePath, options = {}) => {
    // Pipeline Gzip
    const gzipJob = pipeline(
        createReadStream(filePath),
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );
    
    // Pipeline Brotli
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

    // Pipeline Zstandard (Zstd)
    const zstdLevel = options.fastCompression ? 3 : 19;
  
    const zstdJob = pipeline(
        createReadStream(filePath),
        ZstdStream.compress({ level: zstdLevel }),
        createWriteStream(`${filePath}.zst`)
    );
  
    await Promise.all([gzipJob, brotliJob, zstdJob]);
};

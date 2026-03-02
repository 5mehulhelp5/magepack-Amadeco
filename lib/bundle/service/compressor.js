import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ZstdInit } from '@oneidentity/zstd-js';

/**
 * Cache for the Zstandard WebAssembly module initialization.
 * Ensures that the WASM module is loaded and compiled only once during the build process.
 * @type {Promise<Object>|null}
 */
let zstdInitPromise = null;

/**
 * Compresses a file using Gzip, Brotli, and Zstandard (Zstd) concurrently.
 * * - Gzip and Brotli leverage Node.js native streams to maintain a low memory footprint.
 * - Zstd reads the file entirely into memory and processes it, as its WebAssembly 
 * implementation does not natively support Node.js Transform streams. This is safe 
 * since JavaScript bundles are relatively small (usually < 2MB).
 *
 * @param {string} filePath - The absolute path to the generated JavaScript bundle file.
 * @param {Object} [options={}] - Configuration options for the compression process.
 * @param {boolean} [options.fastCompression=false] - If true, uses lower compression levels 
 * (Brotli default, Zstd level 3) to significantly speed up the build process. 
 * If false, uses maximum compression (Brotli max, Zstd level 22) for production.
 * @returns {Promise<void>} A promise that resolves when all three compressed files (.gz, .br, .zst) have been successfully written to the disk.
 */
export const compressFile = async (filePath, options = {}) => {
    // 1. Gzip Pipeline (Stream)
    const gzipJob = pipeline(
        createReadStream(filePath),
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );
    
    // 2. Brotli Pipeline (Stream)
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

    // 3. Zstandard Job (Memory Buffer)
    const zstdJob = async () => {
        // Initialize the WebAssembly module if it hasn't been initialized yet
        if (!zstdInitPromise) {
            zstdInitPromise = ZstdInit();
        }
        
        // Wait for initialization and extract the ZstdStream API
        const { ZstdStream } = await zstdInitPromise; 

        // Determine Zstd compression level: 3 is standard/fast, 22 is ultra/max
        const zstdLevel = options.fastCompression ? 3 : 22;
        
        // Read the entire source file into a Buffer
        const fileBuffer = await readFile(filePath);
        
        // Compress the data using the Zstd WebAssembly module
        // Note: ZstdStream.compress requires a Uint8Array
        const compressedData = ZstdStream.compress(new Uint8Array(fileBuffer), zstdLevel);
        
        // Write the compressed data out to the .zst file
        await writeFile(`${filePath}.zst`, compressedData);
    };
  
    // Execute all three compression tasks concurrently to minimize build time
    await Promise.all([gzipJob, brotliJob, zstdJob()]);
};

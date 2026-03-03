/**
 * @fileoverview File Compression Service for Magepack.
 * Handles the concurrent generation of Gzip (.gz), Brotli (.br), and Zstandard (.zst) 
 * compressed assets to optimize frontend delivery in Magento 2 environments.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createGzip, createBrotliCompress, constants } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ZstdInit } from '@oneidentity/zstd-js';

/**
 * Cache for the Zstandard WebAssembly module initialization.
 * Ensures that the WASM module is loaded, compiled, and allocated only once 
 * during the entire build process, preventing memory leaks and overhead.
 * * @type {Promise<Object>|null}
 */
let zstdInitPromise = null;

/**
 * Compresses a target file using Gzip, Brotli, and Zstandard (Zstd) concurrently.
 * * Architecture notes:
 * - Gzip and Brotli leverage Node.js native streams (`node:zlib`) to maintain 
 * a near-zero memory footprint during execution.
 * - Zstd uses a WebAssembly port. Because the WASM stream API is chunk-based, 
 * we use `ZstdSimple` to compress the entire file buffer in a single pass. 
 * This guarantees correct file headers/magic numbers for Nginx static delivery.
 *
 * @async
 * @param {string} filePath - The absolute path to the generated JavaScript bundle file.
 * @param {Object} [options={}] - Configuration options for the compression process.
 * @param {boolean} [options.fastCompression=false] - If true, uses lower compression levels 
 * (Brotli default, Zstd level 3) to significantly speed up CI/CD build times. 
 * If false, uses maximum safe compression (Brotli max, Zstd level 19) for production.
 * @returns {Promise<void>} A promise that resolves when all three compressed files (.gz, .br, .zst) have been successfully written to disk.
 * @throws {Error} If reading the source file or writing the compressed streams fails.
 */
export const compressFile = async (filePath, options = {}) => {
    // 1. Gzip Pipeline (Native Stream)
    // Always uses maximum compression as Gzip is naturally fast.
    const gzipJob = pipeline(
        createReadStream(filePath),
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        createWriteStream(`${filePath}.gz`)
    );
    
    // 2. Brotli Pipeline (Native Stream)
    const brotliQuality = options.fastCompression 
        ? constants.BROTLI_DEFAULT_QUALITY
        : constants.BROTLI_MAX_QUALITY;
  
    const brotliJob = pipeline(
        createReadStream(filePath),
        createBrotliCompress({
            params: {
                [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
                [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                [constants.BROTLI_PARAM_LGWIN]: 24, // Maximum window size for better compression ratio
            },
        }),
        createWriteStream(`${filePath}.br`)
    );

    // 3. Zstandard Job (Memory Buffer / WASM)
    const zstdJob = async () => {
        // Initialize the WebAssembly module if it hasn't been initialized yet
        if (!zstdInitPromise) {
            zstdInitPromise = ZstdInit();
        }
        
        // Wait for initialization and extract the ZstdSimple API for one-shot buffer compression
        const { ZstdSimple } = await zstdInitPromise; 

        // Determine Zstd compression level: 
        // 3 is standard/fast.
        // 19 is the "Ultra" production level. 
        // Note: Level 20+ in WASM requires excessive RAM allocations (often >500MB per file) 
        // and can silently crash Node.js processes. 19 is the optimal safety/ratio limit.
        const zstdLevel = options.fastCompression ? 3 : 19;
        
        // Read the entire source file into a Node.js Buffer
        const fileBuffer = await readFile(filePath);
        
        // Compress the data using the Zstd WebAssembly module
        // ZstdSimple requires the buffer to be cast as a Uint8Array
        const compressedData = ZstdSimple.compress(new Uint8Array(fileBuffer), zstdLevel);
        
        // Write the finalized compressed binary payload to the .zst file
        await writeFile(`${filePath}.zst`, compressedData);
    };
  
    // Execute all three compression tasks concurrently to minimize overall build time
    await Promise.all([gzipJob, brotliJob, zstdJob()]);
};

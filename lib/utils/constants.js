/**
 * @file lib/utils/constants.js
 * @description Centralized constants for paths, filenames, and markers.
 */

export const PATHS = {
    STATIC_FRONTEND: 'pub/static/frontend',
    FRONTEND: 'frontend',
    MAGEPACK_DIR: 'magepack',
    BUILD_DIR: 'magepack_build',
    BACKUP_DIR: 'magepack_backup'
};

export const FILES = {
    REQUIREJS_CONFIG: 'requirejs-config.js',
    REQUIREJS_CONFIG_MIN: 'requirejs-config.min.js',
    SRI_HASHES: 'sri-hashes.json',
    MAGEPACK_CONFIG: 'magepack.config.js'
};

export const MARKERS = {
    START: '/* MAGEPACK START */',
    END: '/* MAGEPACK END */'
};

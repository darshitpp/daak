const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '../..');

const config = {
  watchFolders: [workspaceRoot],
  // Metro starts one worker for each CPU core. Each worker is a child Node
  // process with its own heap. This host has 8 GiB of RAM. Bound the pool.
  maxWorkers: 2,
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);

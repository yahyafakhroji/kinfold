// The OpenCode plugin file's shim helpers live in the plugin-file family, which
// Kilo Code shares; the install code and its tests keep importing them from here.
export { DATA_DIR_CONSTANT, inspectShim, isOwnShim, pluginFileContent, shimContent, shimTarget, type ShimState } from '../agents/families/plugin-file'

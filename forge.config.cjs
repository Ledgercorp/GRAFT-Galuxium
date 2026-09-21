const path = require('node:path');
const fs = require('node:fs');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseVersion, FuseV1Options } = require('@electron/fuses');
// One master artwork, two derived icon resources beside it: icon.icns (macOS) and icon.ico
// (Windows, from scripts/desktop/icon-ico.mjs). Packager appends the platform's extension.
// GRAFT_ICON may point at an alternative icon (without extension) for an experimental build only.
const iconBase = process.env.GRAFT_ICON || path.join(__dirname, 'packages/desktop/assets/icon');
for (const ext of ['.icns', '.ico']) if (!fs.existsSync(iconBase + ext)) throw new Error(`Application icon not found: ${iconBase}${ext}`);
const signing = process.env.GRAFT_SIGN === '1';
const fixture = process.env.GRAFT_BUILD_FIXTURE === '1';
if (signing && fixture) throw new Error('Never sign a deterministic licensing fixture for distribution.');
if (signing && process.platform === 'darwin' && (!process.env.APPLE_SIGN_IDENTITY || !process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID)) throw new Error('Signing and notarization require externally supplied Apple credentials.');
if (signing && process.platform === 'win32') throw new Error('Windows code signing is not configured; build the unsigned release candidate without GRAFT_SIGN.');
const productName = fixture ? 'GRAFT Fixture' : 'GRAFT';
const version = require('./package.json').version;
module.exports = {
  packagerConfig: {
    name: productName, executableName: productName,
    appBundleId: fixture ? 'com.leftsock.graft.fixture' : 'com.leftsock.graft',
    appCategoryType: 'public.app-category.developer-tools', asar: true, prune: false,
    extraResource: [path.join(__dirname, '.desktop-build/runtime'), path.join(__dirname, 'node_modules/electron/LICENSE')],
    // Development signatures repair the upstream Electron signature after renaming/fuse changes.
    // They carry no Developer ID identity and are not suitable for public distribution.
    osxSign: { identity: '-', identityValidation: false, preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }) },
    icon: iconBase,
    // Windows executable metadata (Properties > Details). Unsigned until a certificate exists.
    win32metadata: { CompanyName: 'GRAFT', ProductName: productName, FileDescription: `${productName} desktop`, InternalName: productName },
    ...(signing ? { osxSign: { identity: process.env.APPLE_SIGN_IDENTITY, hardenedRuntime: true,
      optionsForFile: (file) => ({ entitlements: path.join(__dirname, 'packages/desktop/config/entitlements.plist'), hardenedRuntime: true }) },
      osxNotarize: { appleId: process.env.APPLE_ID, appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD, teamId: process.env.APPLE_TEAM_ID } } : {}),
  },
  makers: [
    // macOS: DMG installer + ZIP.
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'], config: { format: 'ULFO', overwrite: true, icon: iconBase + '.icns' } },
    // Windows: a one-click Squirrel Setup.exe (no MSI) + ZIP. Squirrel installs per-user under
    // %LocalAppData%\\GRAFT, needs no administrator rights, and registers an uninstaller.
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: {
      name: fixture ? 'GRAFTFixture' : 'GRAFT', title: productName, authors: 'GRAFT', description: 'GRAFT desktop',
      exe: `${productName}.exe`, setupExe: `${productName.replace(/ /g, '-')}-${version}-Setup.exe`, setupIcon: iconBase + '.ico', noMsi: true } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32'] },
  ],
  plugins: [new FusesPlugin({ version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false, [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, [FuseV1Options.OnlyLoadAppFromAsar]: true,
  })],
};

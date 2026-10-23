// Refuse an unsigned/ad-hoc Mac distribution before copying the app skeleton.
// Windows intentionally remains unsigned. This hook never reads signing keys.
function validateMacSigningPolicy(context, env = process.env) {
  if (context.electronPlatformName !== 'darwin') return
  const options = context.packager.platformSpecificBuildOptions
  if (options.forceCodeSigning !== true || options.type !== 'distribution') {
    throw new Error('Mac distribution requires forceCodeSigning=true and type=distribution.')
  }
  if (options.identity === null || options.identity === '-' || env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') {
    throw new Error('Mac distribution signing must not be disabled or replaced with ad-hoc signing.')
  }
  // osx-sign 1.3.1 serializes true as the invalid flag --strict=true. Its
  // unset default emits --strict; afterSign independently uses literal --strict.
  if (options.strictVerify !== undefined) {
    throw new Error('Keep the strict-verification default; do not override strictVerify.')
  }
}

module.exports = context => validateMacSigningPolicy(context)
module.exports.validateMacSigningPolicy = validateMacSigningPolicy

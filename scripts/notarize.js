const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return
  if (process.env.SKIP_NOTARIZE === 'true') {
    console.log('Skipping notarization — SKIP_NOTARIZE is set')
    return
  }
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD
  if (!process.env.APPLE_ID || !appleIdPassword || !process.env.APPLE_TEAM_ID) {
    console.log('Skipping notarization — missing APPLE_ID, APPLE_ID_PASSWORD/APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID')
    return
  }

  const appName = context.packager.appInfo.productFilename
  console.log(`Notarizing ${appName}...`)

  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: appleIdPassword,
    teamId: process.env.APPLE_TEAM_ID
  })

  console.log('Notarization complete')
}

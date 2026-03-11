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
  const appPath = `${appOutDir}/${appName}.app`
  const maxRetries = 3

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Notarizing ${appName} (attempt ${attempt}/${maxRetries})...`)
      await notarize({
        appPath,
        appleId: process.env.APPLE_ID,
        appleIdPassword: appleIdPassword,
        teamId: process.env.APPLE_TEAM_ID
      })
      console.log('Notarization complete')
      return
    } catch (err) {
      const msg = err.message || ''
      const isTransient = /offline|network|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(msg)
      if (isTransient && attempt < maxRetries) {
        const delay = attempt * 30
        console.log(`Notarization failed (transient): ${msg}`)
        console.log(`Retrying in ${delay}s...`)
        await new Promise((r) => setTimeout(r, delay * 1000))
      } else {
        throw err
      }
    }
  }
}

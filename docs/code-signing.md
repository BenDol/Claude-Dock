# Code Signing Setup

## macOS (Apple Developer ID)

### Prerequisites
- Apple Developer account ($99/year)
- macOS machine for certificate generation

### Generate Certificate
1. Open **Keychain Access** → menu **Keychain Access** → **Certificate Assistant** → **Request a Certificate From a Certificate Authority**
2. Enter your email and name, select **Saved to disk**
3. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list)
4. Click **+** → select **Developer ID Application** → upload the `.certSigningRequest` file
5. Download the `.cer` file, double-click to import into Keychain Access
6. In Keychain Access → **My Certificates** → find the certificate → right-click → **Export Items** → save as `.p12`

### GitHub Secrets
| Secret | Value |
|--------|-------|
| `MAC_CERTIFICATE` | Base64 of .p12 file (`base64 -w 0 cert.p12 \| clip`) |
| `MAC_CERTIFICATE_PASSWORD` | Password set when exporting .p12 |
| `APPLE_ID` | Apple ID email |
| `APPLE_ID_PASSWORD` | [App-specific password](https://appleid.apple.com/account/manage) |
| `APPLE_TEAM_ID` | Team ID from Apple Developer account |

### Enable Signing & Notarization
In `.github/workflows/build.yml`, update the Package step env vars:
```yaml
CSC_IDENTITY_AUTO_DISCOVERY: 'true'
SKIP_NOTARIZE: ${{ github.event_name == 'pull_request' && 'true' || 'false' }}
```

Currently both are hardcoded to skip (`CSC_IDENTITY_AUTO_DISCOVERY: 'false'`, `SKIP_NOTARIZE: 'true'`).
The original expressions are preserved as comments next to each line.

### Notes
- Signing alone is not enough — macOS Catalina+ requires **notarization** for downloaded apps to open without warnings
- Without notarization, users must right-click → Open or run `xattr -cr /Applications/Claude\ Dock.app`
- Notarization adds 5-15 minutes per architecture to the CI build
- Universal builds (arm64 + x64 in one binary) double the notarization time vs a single arch

---

## Windows (Azure Trusted Signing)

### Prerequisites
- Azure account ([portal.azure.com](https://portal.azure.com))

### Setup
1. In Azure Portal, search for **Artifact Signing Accounts** (formerly "Trusted Signing")
2. Create a signing account (pick a region and resource group)
3. Inside the account, go to **Identity validation** → create a new validation request (Public Trust, Individual or Organization)
4. Complete identity verification (takes 1-7 days for approval)
5. Once approved, go to **Certificate profiles** → create a profile linked to your validated identity

### Create Azure AD App for CI/CD
1. Go to **Azure Active Directory** → **App registrations** → **New registration**
2. Name it (e.g. "Claude Dock Signing")
3. Note the **Application (client) ID** and **Directory (tenant) ID**
4. Go to **Certificates & secrets** → **New client secret** → copy the value
5. Back in the signing account → **Access control (IAM)** → add role **Trusted Signing Certificate Profile Signer** to the app

### GitHub Secrets
| Secret | Value |
|--------|-------|
| `AZURE_TENANT_ID` | Directory/tenant ID |
| `AZURE_CLIENT_ID` | App registration client ID |
| `AZURE_CLIENT_SECRET` | Client secret value |
| `AZURE_SIGNING_ENDPOINT` | Account endpoint (e.g. `https://eus.codesigning.azure.net`) |
| `AZURE_SIGNING_ACCOUNT` | Signing account name |
| `AZURE_CERT_PROFILE` | Certificate profile name |

### Workflow Integration
Add a signing step after the Package step using `azure/trusted-signing-action`:
```yaml
- name: Sign Windows binaries
  if: matrix.platform == 'win'
  uses: azure/trusted-signing-action@v0.5.0
  with:
    azure-tenant-id: ${{ secrets.AZURE_TENANT_ID }}
    azure-client-id: ${{ secrets.AZURE_CLIENT_ID }}
    azure-client-secret: ${{ secrets.AZURE_CLIENT_SECRET }}
    endpoint: ${{ secrets.AZURE_SIGNING_ENDPOINT }}
    trusted-signing-account-name: ${{ secrets.AZURE_SIGNING_ACCOUNT }}
    certificate-profile-name: ${{ secrets.AZURE_CERT_PROFILE }}
    files-folder: dist
    files-folder-filter: exe
    file-digest: SHA256
```

### Notes
- Azure Trusted Signing costs ~$10/month
- No hardware token required — fully cloud-based
- EV-equivalent SmartScreen reputation once identity is verified
- Signing is fast (seconds) unlike macOS notarization

---

## Linux

Linux has no code signing requirement. AppImage files run as-is with execute permission.

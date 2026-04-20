/**
 * OS-level context menu integration for Claude Dock.
 *
 * - Windows: IExplorerCommand COM handler for Win11 modern context menu,
 *   with classic registry fallback for "Show more options".
 * - macOS: Finder Quick Action (Automator .workflow bundle) in ~/Library/Services/
 * - Linux: .desktop file with actions in ~/.local/share/nemo/actions/ and
 *   ~/.local/share/nautilus/scripts/, plus KDE service menu.
 */

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execSync, execFileSync } from 'child_process'
import { log, logError } from './logger'
import {
  ENV_PROFILE,
  getAppName,
  getContextMenuCanonicalGuid,
  getContextMenuClsid,
  getContextMenuLabel,
  getShellExtensionIdentifier,
  getUserDataDirName
} from '../shared/env-profile'

// ---------------------------------------------------------------------------
// Windows — Constants (profile-aware)
// ---------------------------------------------------------------------------

const SHELL_ID = getShellExtensionIdentifier()
const MENU_LABEL = getContextMenuLabel()
const WIN_REG_DIR = `HKCU\\Software\\Classes\\Directory\\shell\\${SHELL_ID}`
const WIN_REG_BG = `HKCU\\Software\\Classes\\Directory\\Background\\shell\\${SHELL_ID}`
const COM_CLSID = getContextMenuClsid()
const CANONICAL_GUID = getContextMenuCanonicalGuid()
const WIN_CLSID_KEY = `HKCU\\Software\\Classes\\CLSID\\${COM_CLSID}`
const WIN_META_KEY = `HKCU\\Software\\${SHELL_ID}`
const DLL_NAME = `${SHELL_ID}Menu.dll`
const CS_FILE_NAME = `${SHELL_ID}Menu.cs`
const ASSEMBLY_NAME = `${SHELL_ID}Menu`
const COM_CLASS_NAME = `OpenWith${SHELL_ID}`

// Linux filenames need to be profile-unique too so two installs don't share
// a single ~/.local/share/<...>/claude-dock entry.
const LINUX_BASE = getUserDataDirName() // 'claude-dock' for uat, 'claude-dock-prod' etc.
const LINUX_NEMO_FILE = `${LINUX_BASE}.nemo_action`
const LINUX_KDE_FILE = `${LINUX_BASE}.desktop`
// KDE action identifiers must be alphanumeric — derive from SHELL_ID (already PascalCase, no punctuation).
const KDE_ACTION_ID = `open${SHELL_ID}`

// ---------------------------------------------------------------------------
// Windows — IExplorerCommand COM DLL (compiled at runtime via csc.exe)
// ---------------------------------------------------------------------------

/**
 * C# source for a .NET COM DLL implementing IExplorerCommand.
 * When registered as an ExplorerCommandHandler, Windows 11 shows it in the
 * modern (first-level) context menu instead of relegating it to "Show more options".
 *
 * The DLL reads the exe path from HKCU\Software\<SHELL_ID>\ExePath at runtime
 * so it remains valid across auto-updates without recompilation.
 *
 * The source is templated with the profile identifier so that each installable
 * profile compiles its own uniquely-named class / CLSID / registry path —
 * otherwise two profiles would register colliding COM classes.
 */
const CLSID_HEX = COM_CLSID.replace(/[{}]/g, '')
const CS_SOURCE = `using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace ${SHELL_ID}
{
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IntPtr ppsi);
        [PreserveSig] int GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IntPtr psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItemArray
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppvOut);
        [PreserveSig] int GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetAttributes(int attribFlags, uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int GetCount(out uint pdwNumItems);
        [PreserveSig] int GetItemAt(uint dwIndex, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);
        [PreserveSig] int EnumItems(out IntPtr ppenumShellItems);
    }

    [ComImport, Guid("a08ce4d0-fa25-44ab-b57c-c7b1c323e0b9")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IExplorerCommand
    {
        [PreserveSig] int GetTitle(IShellItemArray psiItemArray, out IntPtr ppszName);
        [PreserveSig] int GetIcon(IShellItemArray psiItemArray, out IntPtr ppszIcon);
        [PreserveSig] int GetToolTip(IShellItemArray psiItemArray, out IntPtr ppszInfotip);
        [PreserveSig] int GetCanonicalName(out Guid pguidCommandName);
        [PreserveSig] int GetState(IShellItemArray psiItemArray, [MarshalAs(UnmanagedType.Bool)] bool fOkToBeSlow, out uint pCmdState);
        [PreserveSig] int Invoke(IShellItemArray psiItemArray, IntPtr pbc);
        [PreserveSig] int GetFlags(out uint pFlags);
        [PreserveSig] int EnumSubCommands(out IntPtr ppEnum);
    }

    [ComVisible(true)]
    [Guid("${CLSID_HEX}")]
    [ClassInterface(ClassInterfaceType.None)]
    public class ${COM_CLASS_NAME} : IExplorerCommand
    {
        private const uint SIGDN_FILESYSPATH = 0x80058000;

        private static string GetExePath()
        {
            try
            {
                RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\\\${SHELL_ID}");
                if (key != null)
                {
                    object val = key.GetValue("ExePath");
                    key.Close();
                    if (val != null) return val.ToString();
                }
            }
            catch {}
            return "";
        }

        public int GetTitle(IShellItemArray psiItemArray, out IntPtr ppszName)
        {
            ppszName = Marshal.StringToCoTaskMemUni("${MENU_LABEL}");
            return 0;
        }

        public int GetIcon(IShellItemArray psiItemArray, out IntPtr ppszIcon)
        {
            ppszIcon = Marshal.StringToCoTaskMemUni(GetExePath());
            return 0;
        }

        public int GetToolTip(IShellItemArray psiItemArray, out IntPtr ppszInfotip)
        {
            ppszInfotip = IntPtr.Zero;
            return 1;
        }

        public int GetCanonicalName(out Guid pguidCommandName)
        {
            pguidCommandName = new Guid("${CANONICAL_GUID}");
            return 0;
        }

        public int GetState(IShellItemArray psiItemArray, bool fOkToBeSlow, out uint pCmdState)
        {
            pCmdState = 0;
            return 0;
        }

        public int Invoke(IShellItemArray psiItemArray, IntPtr pbc)
        {
            try
            {
                string folderPath = "";
                if (psiItemArray != null)
                {
                    uint count;
                    if (psiItemArray.GetCount(out count) == 0 && count > 0)
                    {
                        IShellItem item;
                        if (psiItemArray.GetItemAt(0, out item) == 0 && item != null)
                        {
                            string p;
                            if (item.GetDisplayName(SIGDN_FILESYSPATH, out p) == 0 && p != null)
                                folderPath = p;
                            Marshal.ReleaseComObject(item);
                        }
                    }
                }
                string exePath = GetExePath();
                if (!string.IsNullOrEmpty(exePath) && System.IO.File.Exists(exePath))
                {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = exePath;
                    psi.Arguments = "\\\"" + folderPath + "\\\"";
                    psi.UseShellExecute = false;
                    Process.Start(psi);
                }
            }
            catch {}
            return 0;
        }

        public int GetFlags(out uint pFlags)
        {
            pFlags = 0;
            return 0;
        }

        public int EnumSubCommands(out IntPtr ppEnum)
        {
            ppEnum = IntPtr.Zero;
            return 1;
        }
    }
}
`

function getShellExtDir(): string {
  return path.join(app.getPath('userData'), 'shell-extension')
}

function getDllPath(): string {
  return path.join(getShellExtDir(), DLL_NAME)
}

function findCscExe(): string | null {
  const winDir = process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * Compile the IExplorerCommand COM DLL if it doesn't exist yet.
 * Uses csc.exe from .NET Framework 4.x (always present on Windows 10/11).
 */
function ensureShellExtDll(): boolean {
  const dllPath = getDllPath()
  if (fs.existsSync(dllPath)) return true

  const csc = findCscExe()
  if (!csc) {
    log('[context-menu] csc.exe not found — skipping COM DLL compilation')
    return false
  }

  const dir = getShellExtDir()
  fs.mkdirSync(dir, { recursive: true })

  const csPath = path.join(dir, CS_FILE_NAME)
  fs.writeFileSync(csPath, CS_SOURCE)

  try {
    execFileSync(
      csc,
      ['/target:library', `/out:${dllPath}`, '/platform:anycpu', '/nologo', csPath],
      { encoding: 'utf8', timeout: 30000, windowsHide: true }
    )
    try { fs.unlinkSync(csPath) } catch { /* best effort */ }
    if (fs.existsSync(dllPath)) {
      log('[context-menu] compiled IExplorerCommand COM DLL')
      return true
    }
  } catch (e) {
    log(`[context-menu] csc.exe compilation failed: ${e}`)
  }
  try { fs.unlinkSync(csPath) } catch { /* best effort */ }
  return false
}

/**
 * Register the COM class in HKCU and set ExplorerCommandHandler on the verb keys.
 * This promotes the entry from "Show more options" to the Win11 modern context menu.
 */
function registerComHandler(exePath: string): boolean {
  const dllPath = getDllPath()
  const codeBase = 'file:///' + dllPath.replace(/\\/g, '/')
  const regOpts = { encoding: 'utf8' as const, windowsHide: true, timeout: 10000 }

  try {
    // Register CLSID — all entries must succeed for a valid COM registration
    const clsidCmds = [
      `reg add "${WIN_CLSID_KEY}" /ve /d "${COM_CLASS_NAME}" /f`,
      `reg add "${WIN_CLSID_KEY}\\InprocServer32" /ve /d "mscoree.dll" /f`,
      `reg add "${WIN_CLSID_KEY}\\InprocServer32" /v "ThreadingModel" /d "Both" /f`,
      `reg add "${WIN_CLSID_KEY}\\InprocServer32" /v "Assembly" /d "${ASSEMBLY_NAME}, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null" /f`,
      `reg add "${WIN_CLSID_KEY}\\InprocServer32" /v "Class" /d "${SHELL_ID}.${COM_CLASS_NAME}" /f`,
      `reg add "${WIN_CLSID_KEY}\\InprocServer32" /v "RuntimeVersion" /d "v4.0.30319" /f`,
      `reg add "${WIN_CLSID_KEY}\\InprocServer32" /v "CodeBase" /d "${codeBase}" /f`
    ]
    for (const cmd of clsidCmds) execSync(cmd, regOpts)

    // Store exe path for the COM DLL to read at runtime
    execSync(`reg add "${WIN_META_KEY}" /v "ExePath" /d "${exePath}" /f`, regOpts)

    // Set ExplorerCommandHandler on both verb entries
    execSync(`reg add "${WIN_REG_DIR}" /v "ExplorerCommandHandler" /d "${COM_CLSID}" /f`, regOpts)
    execSync(`reg add "${WIN_REG_BG}" /v "ExplorerCommandHandler" /d "${COM_CLSID}" /f`, regOpts)

    log('[context-menu] Windows: registered COM handler for modern context menu')
    return true
  } catch (e) {
    log(`[context-menu] COM handler registration failed: ${e}`)
    // Clean up partial registration
    unregisterComHandler()
    return false
  }
}

function unregisterComHandler(): void {
  const regOpts = { encoding: 'utf8' as const, windowsHide: true, timeout: 10000 }
  // Remove ExplorerCommandHandler from verb entries (restores classic command subkey usage)
  try { execSync(`reg delete "${WIN_REG_DIR}" /v "ExplorerCommandHandler" /f`, regOpts) } catch { /* ok */ }
  try { execSync(`reg delete "${WIN_REG_BG}" /v "ExplorerCommandHandler" /f`, regOpts) } catch { /* ok */ }
  // Remove CLSID entries
  try { execSync(`reg delete "${WIN_CLSID_KEY}" /f`, regOpts) } catch { /* ok */ }
  // Remove metadata key
  try { execSync(`reg delete "${WIN_META_KEY}" /f`, regOpts) } catch { /* ok */ }
  // Try to delete the DLL (may fail if loaded by Explorer — harmless, it won't be used)
  try { fs.unlinkSync(getDllPath()) } catch { /* ok */ }
}

// ---------------------------------------------------------------------------
// Windows — Classic registry (fallback for "Show more options")
// ---------------------------------------------------------------------------

function windowsRegisterClassic(exePath: string): void {
  const regOpts = { encoding: 'utf8' as const, windowsHide: true, timeout: 10000 }
  const cmds = [
    `reg add "${WIN_REG_DIR}" /ve /d "${MENU_LABEL}" /f`,
    `reg add "${WIN_REG_DIR}" /v "Icon" /d "${exePath}" /f`,
    `reg add "${WIN_REG_DIR}\\command" /ve /d "\\"${exePath}\\" \\"%V\\"" /f`,
    `reg add "${WIN_REG_BG}" /ve /d "${MENU_LABEL}" /f`,
    `reg add "${WIN_REG_BG}" /v "Icon" /d "${exePath}" /f`,
    `reg add "${WIN_REG_BG}\\command" /ve /d "\\"${exePath}\\" \\"%V\\"" /f`
  ]
  for (const cmd of cmds) {
    try { execSync(cmd, regOpts) } catch { /* best effort per entry */ }
  }
}

// ---------------------------------------------------------------------------
// Windows — Combined register / unregister / check / refresh
// ---------------------------------------------------------------------------

function windowsRegister(): { success: boolean; error?: string } {
  try {
    const exePath = app.getPath('exe')

    // 1. Always write classic registry entries (verb + command + icon).
    //    These serve as fallback if the COM approach fails and also provide
    //    the entry for older Windows versions.
    windowsRegisterClassic(exePath)

    // 2. Try to compile the COM DLL and register the IExplorerCommand handler.
    //    This promotes the entry to the Win11 modern context menu.
    if (ensureShellExtDll()) {
      registerComHandler(exePath)
    }

    log('[context-menu] Windows: registered context menu entries')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] Windows register failed:', msg)
    return { success: false, error: msg }
  }
}

function windowsUnregister(): { success: boolean; error?: string } {
  try {
    // Remove COM handler first
    unregisterComHandler()
    // Remove classic verb entries
    try { execSync(`reg delete "${WIN_REG_DIR}" /f`, { encoding: 'utf8', windowsHide: true }) } catch { /* may not exist */ }
    try { execSync(`reg delete "${WIN_REG_BG}" /f`, { encoding: 'utf8', windowsHide: true }) } catch { /* may not exist */ }
    log('[context-menu] Windows: removed context menu entries')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] Windows unregister failed:', msg)
    return { success: false, error: msg }
  }
}

function windowsIsRegistered(): boolean {
  try {
    execSync(`reg query "${WIN_REG_DIR}" /ve`, { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * Read the exe path from the ClaudeDock metadata key (used by the COM DLL),
 * falling back to the classic command subkey.
 */
function windowsGetRegisteredExe(): string | null {
  const regOpts = { encoding: 'utf8' as const, windowsHide: true, timeout: 5000 }
  // Try metadata key first (COM approach)
  try {
    const output = execSync(`reg query "${WIN_META_KEY}" /v "ExePath"`, regOpts)
    const match = output.match(/ExePath\s+REG_SZ\s+(.+)/)
    if (match) return match[1].trim()
  } catch { /* ok */ }

  // Fallback to classic command subkey
  try {
    const output = execSync(`reg query "${WIN_REG_DIR}\\command" /ve`, regOpts)
    const match = output.match(/"([^"]+)"/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function windowsRefreshIfNeeded(): void {
  if (!windowsIsRegistered()) return

  const registeredExe = windowsGetRegisteredExe()
  if (!registeredExe) return

  const currentExe = app.getPath('exe')

  if (registeredExe.toLowerCase() === currentExe.toLowerCase()) return

  if (fs.existsSync(registeredExe)) return // different install — don't touch

  log(`[context-menu] Windows: refreshing stale registry (old: ${registeredExe}, new: ${currentExe})`)
  // Update classic entries
  try { windowsRegisterClassic(currentExe) } catch { /* best effort */ }
  // Update COM metadata
  try { execSync(`reg add "${WIN_META_KEY}" /v "ExePath" /d "${currentExe}" /f`, { encoding: 'utf8', windowsHide: true, timeout: 10000 }) } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// macOS — Finder Quick Action (Automator .workflow bundle)
// ---------------------------------------------------------------------------

function macRegister(): { success: boolean; error?: string } {
  try {
    const exePath = app.getPath('exe')
    const appPath = exePath.includes('.app/Contents/')
      ? exePath.substring(0, exePath.indexOf('.app/') + 4)
      : exePath

    const servicesDir = path.join(app.getPath('home'), 'Library', 'Services')
    const workflowDir = path.join(servicesDir, `${MENU_LABEL}.workflow`)
    const contentsDir = path.join(workflowDir, 'Contents')

    fs.mkdirSync(contentsDir, { recursive: true })

    const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>${MENU_LABEL}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSSendFileTypes</key>
			<array>
				<string>public.folder</string>
			</array>
		</dict>
	</array>
</dict>
</plist>`

    const wflow = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>523</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<integer>2</integer>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<false/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>1.0.2</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMLargeIconName</key>
				<string>RunShellScript</string>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>for f in "$@"; do
	open -a "${appPath}" --args "$f"
done</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/bash</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>1.0.2</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>A1A1A1A1-B2B2-C3C3-D4D4-E5E5E5E5E5E5</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
				</array>
				<key>OutputUUID</key>
				<string>F6F6F6F6-A7A7-B8B8-C9C9-D0D0D0D0D0D0</string>
				<key>UUID</key>
				<string>12345678-1234-1234-1234-123456789ABC</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>0</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string>/bin/sh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<integer>0</integer>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>isViewVisible</key>
				<true/>
				<key>location</key>
				<string>529.000000:620.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>`

    fs.writeFileSync(path.join(contentsDir, 'Info.plist'), infoPlist)
    fs.writeFileSync(path.join(contentsDir, 'document.wflow'), wflow)

    try {
      execSync('/System/Library/CoreServices/pbs -flush', { encoding: 'utf8', timeout: 5000 })
    } catch { /* best effort */ }

    log('[context-menu] macOS: registered Finder Quick Action')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] macOS register failed:', msg)
    return { success: false, error: msg }
  }
}

function macUnregister(): { success: boolean; error?: string } {
  try {
    const workflowDir = path.join(
      app.getPath('home'), 'Library', 'Services', `${MENU_LABEL}.workflow`
    )
    if (fs.existsSync(workflowDir)) {
      fs.rmSync(workflowDir, { recursive: true, force: true })
    }
    try {
      execSync('/System/Library/CoreServices/pbs -flush', { encoding: 'utf8', timeout: 5000 })
    } catch { /* best effort */ }

    log('[context-menu] macOS: removed Finder Quick Action')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] macOS unregister failed:', msg)
    return { success: false, error: msg }
  }
}

function macIsRegistered(): boolean {
  const workflowDir = path.join(
    app.getPath('home'), 'Library', 'Services', `${MENU_LABEL}.workflow`
  )
  return fs.existsSync(workflowDir)
}

function macRefreshIfNeeded(): void {
  if (!macIsRegistered()) return

  try {
    const wflowPath = path.join(
      app.getPath('home'), 'Library', 'Services',
      `${MENU_LABEL}.workflow`, 'Contents', 'document.wflow'
    )
    const content = fs.readFileSync(wflowPath, 'utf8')

    const exePath = app.getPath('exe')
    const currentAppPath = exePath.includes('.app/Contents/')
      ? exePath.substring(0, exePath.indexOf('.app/') + 4)
      : exePath

    if (content.includes(currentAppPath)) return

    const match = content.match(/open -a "([^"]+)"/)
    if (match && !fs.existsSync(match[1])) {
      log(`[context-menu] macOS: refreshing stale workflow (old: ${match[1]}, new: ${currentAppPath})`)
      macRegister()
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Linux — .desktop file actions + Nautilus scripts + KDE/Dolphin service menu
// ---------------------------------------------------------------------------

function linuxGetExePath(): string {
  const exePath = app.getPath('exe')
  return process.env.APPIMAGE || exePath
}

function linuxRegister(): { success: boolean; error?: string } {
  try {
    const exePath = linuxGetExePath()

    const nemoDir = path.join(app.getPath('home'), '.local', 'share', 'nemo', 'actions')
    fs.mkdirSync(nemoDir, { recursive: true })
    fs.writeFileSync(path.join(nemoDir, LINUX_NEMO_FILE), [
      '[Nemo Action]',
      `Name=${MENU_LABEL}`,
      `Comment=Open this folder in ${getAppName()}`,
      `Exec="${exePath}" "%F"`,
      'Icon-Name=utilities-terminal',
      'Selection=any',
      'Extensions=dir;',
      ''
    ].join('\n'))

    const nautilusDir = path.join(app.getPath('home'), '.local', 'share', 'nautilus', 'scripts')
    fs.mkdirSync(nautilusDir, { recursive: true })
    const nautilusScript = path.join(nautilusDir, MENU_LABEL)
    fs.writeFileSync(nautilusScript, [
      '#!/bin/sh',
      `exec "${exePath}" "$NAUTILUS_SCRIPT_CURRENT_URI" "$@"`,
      ''
    ].join('\n'))
    fs.chmodSync(nautilusScript, 0o755)

    const kdeDir = path.join(app.getPath('home'), '.local', 'share', 'kio', 'servicemenus')
    fs.mkdirSync(kdeDir, { recursive: true })
    fs.writeFileSync(path.join(kdeDir, LINUX_KDE_FILE), [
      '[Desktop Entry]',
      'Type=Service',
      'ServiceTypes=KonqPopupMenu/Plugin',
      'MimeType=inode/directory;',
      `Actions=${KDE_ACTION_ID}`,
      '',
      `[Desktop Action ${KDE_ACTION_ID}]`,
      `Name=${MENU_LABEL}`,
      'Icon=utilities-terminal',
      `Exec="${exePath}" "%f"`,
      ''
    ].join('\n'))

    log('[context-menu] Linux: registered context menu entries')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] Linux register failed:', msg)
    return { success: false, error: msg }
  }
}

function linuxUnregister(): { success: boolean; error?: string } {
  try {
    const files = [
      path.join(app.getPath('home'), '.local', 'share', 'nemo', 'actions', LINUX_NEMO_FILE),
      path.join(app.getPath('home'), '.local', 'share', 'nautilus', 'scripts', MENU_LABEL),
      path.join(app.getPath('home'), '.local', 'share', 'kio', 'servicemenus', LINUX_KDE_FILE)
    ]
    for (const f of files) {
      try { fs.unlinkSync(f) } catch { /* may not exist */ }
    }
    log('[context-menu] Linux: removed context menu entries')
    return { success: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    logError('[context-menu] Linux unregister failed:', msg)
    return { success: false, error: msg }
  }
}

function linuxIsRegistered(): boolean {
  const nemoAction = path.join(
    app.getPath('home'), '.local', 'share', 'nemo', 'actions', LINUX_NEMO_FILE
  )
  const nautilusScript = path.join(
    app.getPath('home'), '.local', 'share', 'nautilus', 'scripts', MENU_LABEL
  )
  const kdeMenu = path.join(
    app.getPath('home'), '.local', 'share', 'kio', 'servicemenus', LINUX_KDE_FILE
  )
  return fs.existsSync(nemoAction) || fs.existsSync(nautilusScript) || fs.existsSync(kdeMenu)
}

function linuxRefreshIfNeeded(): void {
  if (!linuxIsRegistered()) return

  const currentExe = linuxGetExePath()

  try {
    const nemoPath = path.join(
      app.getPath('home'), '.local', 'share', 'nemo', 'actions', LINUX_NEMO_FILE
    )
    if (fs.existsSync(nemoPath)) {
      const content = fs.readFileSync(nemoPath, 'utf8')
      const match = content.match(/Exec="([^"]+)"/)
      if (match && match[1] !== currentExe && !fs.existsSync(match[1])) {
        log(`[context-menu] Linux: refreshing stale entries (old: ${match[1]}, new: ${currentExe})`)
        linuxRegister()
        return
      }
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerContextMenu(): { success: boolean; error?: string } {
  // Dev builds are run-from-source and mutate developer state — don't let them
  // register a shell extension that would survive the dev session.
  if (ENV_PROFILE === 'dev') {
    return { success: false, error: 'Context menu registration disabled in dev builds' }
  }
  switch (process.platform) {
    case 'win32': return windowsRegister()
    case 'darwin': return macRegister()
    case 'linux': return linuxRegister()
    default: return { success: false, error: `Unsupported platform: ${process.platform}` }
  }
}

export function unregisterContextMenu(): { success: boolean; error?: string } {
  switch (process.platform) {
    case 'win32': return windowsUnregister()
    case 'darwin': return macUnregister()
    case 'linux': return linuxUnregister()
    default: return { success: false, error: `Unsupported platform: ${process.platform}` }
  }
}

export function isContextMenuRegistered(): boolean {
  switch (process.platform) {
    case 'win32': return windowsIsRegistered()
    case 'darwin': return macIsRegistered()
    case 'linux': return linuxIsRegistered()
    default: return false
  }
}

/**
 * Called on app startup. If context menu entries are registered but point to
 * a stale exe path, re-register with the current exe path.
 * Safe to call every launch — no-ops if entries are current or absent.
 */
export function refreshContextMenuIfNeeded(): void {
  try {
    switch (process.platform) {
      case 'win32': windowsRefreshIfNeeded(); break
      case 'darwin': macRefreshIfNeeded(); break
      case 'linux': linuxRefreshIfNeeded(); break
    }
  } catch (e) {
    logError('[context-menu] refresh failed:', e)
  }
}

/**
 * Auto-register the context menu on first boot after this feature is added.
 * Uses a flag file in userData — once created, auto-registration never runs again.
 * The user can still toggle it via Settings after this.
 */
export function autoRegisterContextMenuOnce(): void {
  // Dev never auto-registers: developers don't want their machine's context
  // menu reshuffled every time they run the app from source.
  if (ENV_PROFILE === 'dev') return
  const flagFile = path.join(app.getPath('userData'), '.context-menu-registered')
  if (fs.existsSync(flagFile)) return

  try {
    // Create the flag file first so we never retry even if registration fails
    fs.writeFileSync(flagFile, new Date().toISOString())

    const result = registerContextMenu()
    if (result.success) {
      log('[context-menu] auto-registered on first boot')
    } else {
      log(`[context-menu] auto-registration failed: ${result.error}`)
    }
  } catch (e) {
    logError('[context-menu] auto-registration error:', e)
  }
}

import { ipcMain, shell, BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import * as path from 'path'
import { IPC } from '../../../shared/ipc-channels'
import { GitManagerWindowManager } from './git-manager-window'
import * as gitOps from './git-operations'
import type { GitLogOptions, GitSearchOptions } from '../../../shared/git-manager-types'
import { getServices } from './services'
import { registerCiIpc } from './ci/ci-ipc'
import { registerPrIpc } from './pr/pr-ipc'

export function registerGitManagerIpc(): void {
  const winManager = GitManagerWindowManager.getInstance()

  ipcMain.handle(IPC.GIT_MGR_IS_REPO, async (_event, projectDir: string) => {
    return gitOps.isGitRepo(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_OPEN, (_event, projectDir: string) => {
    return winManager.open(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_OPEN_COMMIT, (_event, projectDir: string, commitHash: string) => {
    return winManager.openCommitDetail(projectDir, commitHash)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_LOG, async (_event, projectDir: string, opts?: GitLogOptions) => {
    return gitOps.getLog(projectDir, opts)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_COMMIT_COUNT, async (_event, projectDir: string) => {
    return gitOps.getCommitCount(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_COMMIT_INDEX, async (_event, projectDir: string, hash: string) => {
    return gitOps.getCommitIndex(projectDir, hash)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_BRANCHES, async (_event, projectDir: string) => {
    return gitOps.getBranches(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_STATUS, async (_event, projectDir: string, fast?: boolean) => {
    return gitOps.getStatus(projectDir, fast)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_DIFF, async (_event, projectDir: string, filePath?: string, staged?: boolean) => {
    return gitOps.getDiff(projectDir, filePath, staged)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_COMMIT_DETAIL, async (_event, projectDir: string, hash: string) => {
    return gitOps.getCommitDetail(projectDir, hash)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_FILE_BLOB, async (_event, projectDir: string, filePath: string, ref?: string) => {
    return gitOps.getFileBlob(projectDir, filePath, ref)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_COMMIT_FILE_TREE, async (_event, projectDir: string, hash: string) => {
    return gitOps.getCommitFileTree(projectDir, hash)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_FILE_AT_COMMIT, async (_event, projectDir: string, hash: string, filePath: string) => {
    return gitOps.getFileAtCommit(projectDir, hash, filePath)
  })

  ipcMain.handle(IPC.GIT_MGR_STAGE, async (_event, projectDir: string, paths: string[]) => {
    try {
      await gitOps.stageFiles(projectDir, paths)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] stage failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Stage failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_UNSTAGE, async (_event, projectDir: string, paths: string[]) => {
    try {
      await gitOps.unstageFiles(projectDir, paths)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] unstage failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Unstage failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_COMMIT, async (_event, projectDir: string, message: string) => {
    try {
      const result = await gitOps.createCommit(projectDir, message)
      return { success: true, hash: result.hash }
    } catch (err) {
      getServices().logError('[git-manager] commit failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Commit failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_CHECKOUT_BRANCH, async (_event, projectDir: string, name: string, trackRemote?: string) => {
    try {
      await gitOps.checkoutBranch(projectDir, name, trackRemote)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] checkout failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Checkout failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_CREATE_BRANCH, async (_event, projectDir: string, name: string, startPoint?: string) => {
    try {
      await gitOps.createBranch(projectDir, name, startPoint)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] create branch failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Create branch failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_DELETE_BRANCH, async (_event, projectDir: string, name: string, force?: boolean, options?: { deleteRemote?: boolean; deleteLocal?: boolean }) => {
    const results: string[] = []
    try {
      // Delete remote branch if requested
      if (options?.deleteRemote) {
        try {
          await gitOps.deleteRemoteBranch(projectDir, name)
          results.push('remote')
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed'
          if (!options?.deleteLocal) return { success: false, error: `Remote delete failed: ${msg}` }
          results.push(`remote failed: ${msg}`)
        }
      }
      // Delete local branch (or local tracking branch for remote branches)
      if (options?.deleteLocal !== false) {
        // For remote branches like "origin/feature", delete the local tracking ref
        const localName = name.includes('/') ? name.replace(/^[^/]+\//, '') : name
        try {
          await gitOps.deleteBranch(projectDir, localName, force)
          results.push('local')
        } catch (err) {
          // If no options specified (legacy call), throw the error
          if (!options) throw err
          const msg = err instanceof Error ? err.message : 'Failed'
          results.push(`local failed: ${msg}`)
        }
      }
      return { success: true, results }
    } catch (err) {
      getServices().logError('[git-manager] delete branch failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Delete branch failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_PULL, async (_event, projectDir: string, mode?: string) => {
    try {
      const output = await gitOps.pull(projectDir, mode as 'merge' | 'rebase' | undefined)
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] pull failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Pull failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_PULL_ADVANCED, async (_event, projectDir: string, remote: string, branch: string, rebase: boolean, autostash: boolean, tags: boolean, prune: boolean) => {
    try {
      const output = await gitOps.pullAdvanced(projectDir, remote, branch, rebase, autostash, tags, prune)
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] pull advanced failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Pull failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_FETCH_SIMPLE, async (_event, projectDir: string) => {
    try {
      const output = await gitOps.fetchSimple(projectDir)
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] fetch simple failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Fetch failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_FETCH_ALL, async (_event, projectDir: string) => {
    try {
      const output = await gitOps.fetchAll(projectDir)
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] fetch all failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Fetch all failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_FETCH_PRUNE_ALL, async (_event, projectDir: string) => {
    try {
      const output = await gitOps.fetchPruneAll(projectDir)
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] fetch prune all failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Fetch and prune all failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_PUSH, async (event, projectDir: string) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const output = await gitOps.push(projectDir, (progress) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('git-manager:push-progress', progress)
        }
      })
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] push failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Push failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_PUSH_FORCE_WITH_LEASE, async (event, projectDir: string) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const output = await gitOps.pushForceWithLease(projectDir, (progress) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('git-manager:push-progress', progress)
        }
      })
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] push --force-with-lease failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Force push failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_PUSH_WITH_TAGS, async (event, projectDir: string) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const output = await gitOps.pushWithTags(projectDir, (progress) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('git-manager:push-progress', progress)
        }
      })
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] push --follow-tags failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Push with tags failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_PUSH_TAG, async (_event, projectDir: string, tagName: string, force?: boolean) => {
    try {
      await gitOps.pushTag(projectDir, tagName, force)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] push tag failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Push tag failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_CANCEL_PUSH, () => {
    return { cancelled: gitOps.cancelPush() }
  })

  ipcMain.handle(IPC.GIT_MGR_FETCH, async (_event, projectDir: string) => {
    try {
      const output = await gitOps.fetch(projectDir)
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] fetch failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Fetch failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_STASH_LIST, async (_event, projectDir: string) => {
    return gitOps.getStashList(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_STASH_SAVE, async (_event, projectDir: string, message?: string, flags?: string) => {
    try {
      await gitOps.stashSave(projectDir, message, flags)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] stash save failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Stash failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_STASH_APPLY, async (_event, projectDir: string, index: number) => {
    try {
      await gitOps.stashApply(projectDir, index)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] stash apply failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Stash apply failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_STASH_POP, async (_event, projectDir: string, index: number) => {
    try {
      await gitOps.stashPop(projectDir, index)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] stash pop failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Stash pop failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_STASH_DROP, async (_event, projectDir: string, index: number) => {
    try {
      await gitOps.stashDrop(projectDir, index)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] stash drop failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Stash drop failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_GET_SUBMODULES, async (_event, projectDir: string) => {
    return gitOps.getSubmodules(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_REFRESH_SUBMODULE, async (_event, projectDir: string, subPath: string) => {
    return gitOps.refreshSingleSubmodule(projectDir, subPath)
  })

  ipcMain.handle(IPC.GIT_MGR_GENERATE_COMMIT_MSG, async (_event, projectDir: string) => {
    try {
      const message = await gitOps.generateCommitMessage(projectDir)
      return { success: true, message }
    } catch (err) {
      getServices().logError('[git-manager] generate commit message failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Generation failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_RESET, async (_event, projectDir: string, hash: string, mode: string) => {
    try {
      await gitOps.resetBranch(projectDir, hash, mode as 'soft' | 'mixed' | 'keep' | 'merge' | 'hard')
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] reset failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Reset failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_REVERT, async (_event, projectDir: string, hash: string) => {
    try {
      await gitOps.revertCommit(projectDir, hash)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] revert failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Revert failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_CHERRY_PICK, async (_event, projectDir: string, hash: string) => {
    try {
      await gitOps.cherryPick(projectDir, hash)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] cherry-pick failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Cherry pick failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_CREATE_TAG, async (_event, projectDir: string, name: string, hash: string, message?: string) => {
    try {
      await gitOps.createTag(projectDir, name, hash, message)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] create tag failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Create tag failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_GET_TAGS, async (_event, projectDir: string) => {
    return gitOps.getTags(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_DELETE_TAG, async (_event, projectDir: string, name: string) => {
    try {
      await gitOps.deleteTag(projectDir, name)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] delete tag failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Delete tag failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_RENAME_BRANCH, async (_event, projectDir: string, oldName: string, newName: string, renameRemote?: boolean) => {
    try {
      await gitOps.renameBranch(projectDir, oldName, newName, renameRemote)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] rename branch failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Rename branch failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_DISCARD, async (event, projectDir: string, paths: string[]) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      await gitOps.discardFiles(projectDir, paths, (completed, total, path) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('git-manager:discard-progress', { completed, total, path })
        }
      })
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] discard failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Discard failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_RESTORE_FILE_FROM_COMMIT, async (_event, projectDir: string, commitHash: string, filePath: string) => {
    try {
      await gitOps.restoreFileFromCommit(projectDir, commitHash, filePath)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] restore file from commit failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Restore failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_REMOVE_LOCK_FILE, async (_event, projectDir: string) => {
    try {
      await gitOps.removeLockFile(projectDir)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] remove lock file failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Remove lock file failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_DELETE_FILES, async (_event, projectDir: string, paths: string[]) => {
    try {
      await gitOps.deleteUntrackedFiles(projectDir, paths)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] delete files failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Delete failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_APPLY_PATCH, async (_event, projectDir: string, patch: string, cached: boolean, reverse: boolean, fuzzy?: boolean) => {
    try {
      await gitOps.applyPatch(projectDir, patch, cached, reverse, fuzzy)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] apply patch failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Apply patch failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_SHOW_IN_FOLDER, (_event, projectDir: string, filePath: string) => {
    shell.showItemInFolder(path.join(projectDir, filePath))
  })

  ipcMain.handle(IPC.GIT_MGR_ADD_SUBMODULE, async (_event, projectDir: string, url: string, localPath?: string, branch?: string, force?: boolean) => {
    try {
      await gitOps.addSubmodule(projectDir, url, localPath, branch, force)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] add submodule failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Add submodule failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_REGISTER_SUBMODULE, async (_event, projectDir: string, subPath: string) => {
    try {
      await gitOps.registerSubmodule(projectDir, subPath)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] register submodule failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Register submodule failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_REMOVE_SUBMODULE, async (_event, projectDir: string, subPath: string) => {
    try {
      await gitOps.removeSubmodule(projectDir, subPath)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] remove submodule failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Remove submodule failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_SYNC_SUBMODULES, async (_event, projectDir: string, subPaths?: string[]) => {
    try {
      const output = await gitOps.syncSubmodules(projectDir, subPaths)
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] sync submodules failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Sync failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_UPDATE_SUBMODULES, async (_event, projectDir: string, subPaths?: string[], init?: boolean) => {
    try {
      const output = await gitOps.updateSubmodules(projectDir, subPaths, init)
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] update submodules failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Update failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_PULL_REBASE_SUBMODULES, async (_event, projectDir: string, subPaths?: string[]) => {
    try {
      return await gitOps.pullRebaseSubmodules(projectDir, subPaths)
    } catch (err) {
      getServices().logError('[git-manager] pull rebase submodules failed:', err)
      return { results: [{ path: '*', success: false, error: err instanceof Error ? err.message : 'Pull rebase failed' }] }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_CHECK_SUBMODULE_ACCESS, async (_event, projectDir: string, subPath: string) => {
    try {
      const url = await gitOps.getSubmoduleUrl(projectDir, subPath)
      if (!url) return { accessible: false, url: null, error: 'Could not find submodule URL in .gitmodules' }
      const error = await gitOps.checkRemoteAccess(projectDir, url)
      return { accessible: !error, url, error }
    } catch (err) {
      return { accessible: false, url: null, error: err instanceof Error ? err.message : 'Check failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_FORCE_REINIT_SUBMODULE, async (_event, projectDir: string, subPath: string) => {
    try {
      const output = await gitOps.forceReinitSubmodule(projectDir, subPath)
      return { success: true, output }
    } catch (err) {
      getServices().logError('[git-manager] force reinit submodule failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Force reinit failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_GET_REMOTES, async (_event, projectDir: string) => {
    return gitOps.getRemotes(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_ADD_REMOTE, async (_event, projectDir: string, name: string, url: string) => {
    try {
      await gitOps.addRemote(projectDir, name, url)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] add remote failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Add remote failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_REMOVE_REMOTE, async (_event, projectDir: string, name: string) => {
    try {
      await gitOps.removeRemote(projectDir, name)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] remove remote failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Remove remote failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_RENAME_REMOTE, async (_event, projectDir: string, oldName: string, newName: string) => {
    try {
      await gitOps.renameRemote(projectDir, oldName, newName)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] rename remote failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Rename remote failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_SET_REMOTE_URL, async (_event, projectDir: string, name: string, url: string, pushUrl?: string) => {
    try {
      await gitOps.setRemoteUrl(projectDir, name, url, pushUrl)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] set remote url failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Set remote URL failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_GET_MERGE_STATE, async (_event, projectDir: string) => {
    return gitOps.getMergeState(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_CONFLICT_CONTENT, async (_event, projectDir: string, filePath: string) => {
    return gitOps.getConflictFileContent(projectDir, filePath)
  })

  ipcMain.handle(IPC.GIT_MGR_RESOLVE_CONFLICT, async (_event, projectDir: string, filePath: string, resolution: string, chunkIndex?: number) => {
    try {
      await gitOps.resolveConflictFile(projectDir, filePath, resolution as 'ours' | 'theirs' | 'both', chunkIndex)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] resolve conflict failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Resolve conflict failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_ABORT_MERGE, async (_event, projectDir: string) => {
    try {
      await gitOps.abortMerge(projectDir)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] abort merge failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Abort merge failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_CONTINUE_MERGE, async (_event, projectDir: string) => {
    try {
      await gitOps.continueMerge(projectDir)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] continue merge failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Continue merge failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_MERGE_BRANCH, async (_event, projectDir: string, branchName: string) => {
    try {
      await gitOps.mergeBranch(projectDir, branchName)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] merge branch failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Merge failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_GET_BEHIND_COUNT, async (_event, projectDir: string) => {
    return gitOps.getBehindCount(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_SETTING, (_event, projectDir: string, key: string) => {
    return getServices().getPluginSetting(projectDir, 'git-manager', key)
  })

  ipcMain.handle(IPC.GIT_MGR_OPEN_BASH, (_event, projectDir: string) => {
    // Try git-bash locations, fallback to plain bash/sh
    const gitBashPaths = [
      'C:\\Program Files\\Git\\git-bash.exe',
      'C:\\Program Files (x86)\\Git\\git-bash.exe'
    ]
    // Find git.exe and derive git-bash.exe from same dir
    try {
      const { execFileSync } = require('child_process')
      const gitPath = execFileSync('where', ['git'], { timeout: 5000 }).toString().trim().split('\n')[0].trim()
      if (gitPath) {
        // git.exe is usually in cmd/, git-bash.exe is in parent dir
        const gitDir = path.resolve(path.dirname(gitPath), '..')
        gitBashPaths.unshift(path.join(gitDir, 'git-bash.exe'))
      }
    } catch { /* ignore */ }

    const fs = require('fs')
    for (const p of gitBashPaths) {
      if (fs.existsSync(p)) {
        execFile(p, ['--cd=' + projectDir], { detached: true })
        return
      }
    }
    // Fallback: open default terminal in the directory
    shell.openPath(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_IDENTITY, async (_event, projectDir: string) => {
    return gitOps.getGitIdentity(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_SET_IDENTITY, async (_event, projectDir: string, name: string, email: string, global: boolean) => {
    try {
      await gitOps.setGitIdentity(projectDir, name, email, global)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] set identity failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Failed to set identity' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_SEARCH, async (_event, projectDir: string, opts: GitSearchOptions) => {
    return gitOps.searchRepo(projectDir, opts)
  })

  ipcMain.handle(IPC.GIT_MGR_GET_ACTIVE_TERMINALS, async (_event, projectDir: string) => {
    const active = getServices().getActiveTerminals(projectDir)
    return active.map((t: any) => ({ id: t.id, title: t.title, sessionId: t.sessionId }))
  })

  ipcMain.handle(IPC.GIT_MGR_SAVE_FILE, async (_event, projectDir: string, filePath: string, content: string) => {
    try {
      await gitOps.saveFileContent(projectDir, filePath, content)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] save file failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Save failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_PREVIEW_GITIGNORE, async (_event, projectDir: string, pattern: string) => {
    try {
      return await gitOps.previewGitignorePattern(projectDir, pattern)
    } catch (err) {
      getServices().logError('[git-manager] preview gitignore failed:', err)
      return []
    }
  })

  ipcMain.handle(IPC.GIT_MGR_ADD_TO_GITIGNORE, async (_event, projectDir: string, pattern: string, removeFromIndex: boolean) => {
    try {
      await gitOps.addToGitignore(projectDir, pattern, removeFromIndex)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] add to gitignore failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Add to gitignore failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_MIGRATE_TO_LFS, async (_event, projectDir: string, filePaths: string[]) => {
    try {
      const message = await gitOps.migrateToLfs(projectDir, filePaths)
      return { success: true, message }
    } catch (err) {
      getServices().logError('[git-manager] migrate to LFS failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'LFS migration failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_LIST_WORKTREES, async (_event, projectDir: string) => {
    return gitOps.listWorktrees(projectDir)
  })

  ipcMain.handle(IPC.GIT_MGR_ADD_WORKTREE, async (_event, projectDir: string, branch: string, targetPath?: string) => {
    try {
      const worktreePath = await gitOps.addWorktree(projectDir, branch, targetPath)
      return { success: true, path: worktreePath }
    } catch (err) {
      getServices().logError('[git-manager] add worktree failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Add worktree failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_REMOVE_WORKTREE, async (_event, projectDir: string, worktreePath: string, force?: boolean) => {
    try {
      await gitOps.removeWorktree(projectDir, worktreePath, force)
      return { success: true }
    } catch (err) {
      getServices().logError('[git-manager] remove worktree failed:', err)
      return { success: false, error: err instanceof Error ? err.message : 'Remove worktree failed' }
    }
  })

  ipcMain.handle(IPC.GIT_MGR_RESOLVE_WORKTREE, async (_event, projectDir: string, worktreePath: string, commitMessage: string, targetBranch?: string) => {
    return gitOps.resolveWorktree(projectDir, worktreePath, commitMessage, targetBranch)
  })

  ipcMain.handle(IPC.GIT_MGR_RESOLVE_WITH_CLAUDE, async (_event, projectDir: string, filePath: string, instructions: string) => {
    const sent = getServices().sendTaskToDock(projectDir, 'claude:task', {
      type: 'merge-resolve',
      filePath,
      instructions,
      sourceDir: projectDir
    })
    return sent
      ? { success: true }
      : { success: false, error: 'No dock window found for this project' }
  })

  registerCiIpc()

  registerPrIpc()

  getServices().log('[git-manager] IPC handlers registered (v2)')
}

/** Remove all IPC handlers registered by git-manager (for hot-reload) */
export function disposeGitManagerIpc(): void {
  // Remove all GIT_MGR_*, CI_*, and PR_* handlers
  for (const [key, channel] of Object.entries(IPC)) {
    if (key.startsWith('GIT_MGR_') || key.startsWith('CI_') || key.startsWith('PR_')) {
      try { ipcMain.removeHandler(channel as string) } catch { /* ok */ }
    }
  }
}

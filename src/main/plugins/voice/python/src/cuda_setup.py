"""Early CUDA DLL / shared-library path setup.

`faster-whisper` delegates to `ctranslate2`, which eagerly loads CUDA
libraries (`cublas`, `cudnn`) on import when `device='cuda'` or `'auto'`.

On Python 3.8+ Windows the DLL search path no longer includes PATH for
dynamically loaded libraries — callers must register directories with
`os.add_dll_directory()`. That alone turns out to be insufficient here:
ctranslate2's compiled C++ extension calls the *legacy* `LoadLibraryW`
without `LOAD_LIBRARY_SEARCH_USER_DIRS`, which bypasses any user dirs
registered via `AddDllDirectory`. The observable symptom is that
`WhisperModel(device='cuda')` construction succeeds (because some ops
pick up cuBLAS via the `nvidia.cublas` package's transitive initialization),
but the first `transcribe()` call raises
`RuntimeError: Library cublas64_12.dll is not found or cannot be loaded`
when inference tries to lazy-load a kernel like cudnn_ops64_9.dll or
cublasLt64_12.dll. Empirically, the only reliable fix on Windows is to
eagerly `ctypes.CDLL()` every DLL from the nvidia bin/ directories so
Windows' loader ledger has already resolved them by name — later lookups
then succeed via the already-loaded-module fast path, regardless of the
search flags ctranslate2 happens to pass.

We still call `os.add_dll_directory()` alongside the pinning because
it covers the modern `LOAD_LIBRARY_SEARCH_*` callers and because it
keeps the cookies' `RemoveDllDirectory` side-effect from silently
unregistering the paths after this function returns (see `_DLL_COOKIES`).

The `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` PyPI wheels ship those
DLLs under `site-packages/nvidia/cublas/bin/` and `nvidia/cudnn/bin/` on
Windows (and `.so` files under `nvidia/<pkg>/lib/` on Linux). This module
registers AND preloads those directories so ctranslate2 can dlopen them.

Call `setup_cuda_dll_paths()` BEFORE importing `faster_whisper` or
`ctranslate2`. Calling it is a no-op when the nvidia packages aren't
installed — the user has opted out of GPU acceleration and we should
stay on the CPU path without side effects.
"""

import ctypes
import glob
import os
import sys
from typing import Any, Dict, List, Optional, TypedDict


class CudaSetupResult(TypedDict):
    """Return value of setup_cuda_dll_paths()."""

    ok: bool
    """True iff at least one nvidia package was found and wired up."""

    dirs: List[str]
    """The directories successfully added to the DLL search path."""

    missing: List[str]
    """nvidia subpackages that could not be imported (e.g. 'cublas')."""

    error: Optional[str]
    """First error encountered (e.g. add_dll_directory failure), if any."""


# Packages to probe and register. `nvidia-cublas-cu12` installs as
# `nvidia.cublas`; `nvidia-cudnn-cu12` as `nvidia.cudnn`. Order matters on
# Windows: cudnn depends on cublas, so register cublas first.
_NVIDIA_PACKAGES = ("nvidia.cublas", "nvidia.cudnn")

# `os.add_dll_directory()` returns a DllDirectoryCookie whose destructor
# calls `RemoveDllDirectory` — if the cookie is dropped, Windows silently
# removes the directory from the DLL search path. That doesn't unload
# DLLs already in the process, but any later LoadLibrary that *does*
# consult `LOAD_LIBRARY_SEARCH_USER_DIRS` would fail.
#
# Hold the cookies for the process lifetime. Keyed by directory so
# repeated calls to `setup_cuda_dll_paths()` are idempotent and don't
# accumulate duplicate registrations.
_DLL_COOKIES: Dict[str, Any] = {}

# Preloaded `ctypes.CDLL` handles for the nvidia DLLs. Held at module
# scope for the same reason as `_DLL_COOKIES`: dropping the handle would
# let Python close the library, after which ctranslate2's later lazy
# load would fail. Keyed by absolute DLL path.
_PRELOADED_DLLS: Dict[str, Any] = {}


def setup_cuda_dll_paths() -> CudaSetupResult:
    """Make CUDA runtime DLLs discoverable before faster_whisper import.

    Safe to call multiple times — `os.add_dll_directory()` returns a handle
    per call but Windows dedupes internally on path. Always returns without
    raising; inspect the result dict for failures.
    """
    if sys.platform == "win32":
        return _setup_windows()
    # Linux: ctranslate2 respects LD_LIBRARY_PATH, so we prepend the .so
    # directories from the nvidia wheels if present. macOS has no PyPI-
    # shipped CUDA (Metal is the GPU path), so this is a no-op there.
    if sys.platform.startswith("linux"):
        return _setup_linux()
    return {"ok": False, "dirs": [], "missing": [], "error": None}


def _find_dll_dir(package_base: str) -> Optional[str]:
    """Return the subdir of a nvidia-*-cu12 package that holds Windows DLLs."""
    # Newer wheels use `bin/`; some older ones put DLLs straight in `lib/`.
    for sub in ("bin", "lib"):
        d = os.path.join(package_base, sub)
        if os.path.isdir(d):
            try:
                for name in os.listdir(d):
                    if name.lower().endswith(".dll"):
                        return d
            except OSError:
                continue
    return None


def _find_so_dir(package_base: str) -> Optional[str]:
    """Return the subdir of a nvidia-*-cu12 package that holds .so files."""
    for sub in ("lib", "lib64"):
        d = os.path.join(package_base, sub)
        if os.path.isdir(d):
            try:
                for name in os.listdir(d):
                    if ".so" in name:
                        return d
            except OSError:
                continue
    return None


def _package_base_dir(mod: Any) -> Optional[str]:
    """Resolve the on-disk directory of an imported nvidia package.

    The `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` wheels install as PEP 420
    *namespace packages* — no `__init__.py`, so `mod.__file__` is `None`.
    We fall back to `mod.__path__[0]` (the first directory contributing to
    the namespace), which points at the real site-packages/nvidia/<pkg>/
    directory. Without this fallback, the `__file__`-based probe reported
    every nvidia package as missing even when they were correctly installed,
    silently disabling GPU acceleration.
    """
    file_attr = getattr(mod, "__file__", None)
    if file_attr:
        return os.path.dirname(file_attr)
    path_attr = getattr(mod, "__path__", None)
    if path_attr:
        try:
            first = next(iter(path_attr))
        except (StopIteration, TypeError):
            return None
        if first and os.path.isdir(first):
            return first
    return None


def _setup_windows() -> CudaSetupResult:
    dirs: List[str] = []
    missing: List[str] = []
    error: Optional[str] = None
    for pkg in _NVIDIA_PACKAGES:
        try:
            mod = __import__(pkg, fromlist=["__file__"])
        except ImportError:
            # User hasn't opted into GPU acceleration — quiet skip. The caller
            # (transcriber.py) still knows it asked for device='cuda' and will
            # surface a structured warning if ctranslate2 later fails.
            missing.append(pkg.rsplit(".", 1)[-1])
            continue

        base = _package_base_dir(mod)
        if not base:
            missing.append(pkg.rsplit(".", 1)[-1])
            continue

        dll_dir = _find_dll_dir(base)
        if not dll_dir:
            missing.append(pkg.rsplit(".", 1)[-1])
            continue

        if dll_dir not in _DLL_COOKIES:
            try:
                # Store the returned DllDirectoryCookie in a module-level
                # map so it survives for the process lifetime. Dropping it
                # would cause Python to call RemoveDllDirectory on GC,
                # which undoes the search-path registration.
                cookie = os.add_dll_directory(dll_dir)  # type: ignore[attr-defined]
                _DLL_COOKIES[dll_dir] = cookie
            except (OSError, FileNotFoundError) as exc:
                # Keep the first error so callers can surface it; continue
                # with the other packages — partial setup is still better
                # than none.
                if error is None:
                    error = f"{pkg}: {exc}"
                continue

        # Eager-preload every DLL in the directory so they're pinned in
        # the process by absolute path. This is the workaround for
        # ctranslate2 using legacy `LoadLibrary` calls that ignore
        # AddDllDirectory registrations — once a DLL is already in the
        # process's loaded-module table, later `LoadLibraryW("<name>")`
        # calls resolve by name-match instead of going back to the search
        # path, so the lazy loads at inference time succeed.
        preload_err = _preload_dll_dir(dll_dir)
        if preload_err and error is None:
            error = f"{pkg}: {preload_err}"

        dirs.append(dll_dir)
    return {"ok": bool(dirs), "dirs": dirs, "missing": missing, "error": error}


def _preload_dll_dir(dll_dir: str) -> Optional[str]:
    """Pin every *.dll in `dll_dir` into the process via `ctypes.CDLL`.

    Returns the first error message encountered (if any) so the caller
    can surface it. Already-loaded DLLs are skipped via `_PRELOADED_DLLS`
    so repeated calls are cheap and don't accumulate handles.
    """
    first_err: Optional[str] = None
    for dll_path in sorted(glob.glob(os.path.join(dll_dir, "*.dll"))):
        if dll_path in _PRELOADED_DLLS:
            continue
        try:
            _PRELOADED_DLLS[dll_path] = ctypes.CDLL(dll_path)
        except OSError as exc:
            # Don't abort — some wheels ship helper DLLs with unresolved
            # optional deps that only matter for specific code paths. The
            # core libs (cublas64_12, cudnn64_9) are alphabetically early
            # and must succeed; failures further down the list get logged
            # but don't break GPU inference for typical workloads.
            if first_err is None:
                first_err = f"{os.path.basename(dll_path)}: {exc}"
    return first_err


def _setup_linux() -> CudaSetupResult:
    dirs: List[str] = []
    missing: List[str] = []
    error: Optional[str] = None
    for pkg in _NVIDIA_PACKAGES:
        try:
            mod = __import__(pkg, fromlist=["__file__"])
        except ImportError:
            missing.append(pkg.rsplit(".", 1)[-1])
            continue

        base = _package_base_dir(mod)
        if not base:
            missing.append(pkg.rsplit(".", 1)[-1])
            continue

        so_dir = _find_so_dir(base)
        if not so_dir:
            missing.append(pkg.rsplit(".", 1)[-1])
            continue
        dirs.append(so_dir)

    if dirs:
        # Prepend to LD_LIBRARY_PATH so the dynamic linker picks our copies
        # up before any system CUDA install. Fully idempotent: split the
        # existing value, drop entries we'd be re-adding, then join. Without
        # dedup, repeated imports would grow the env var unbounded.
        existing = os.environ.get("LD_LIBRARY_PATH", "")
        existing_parts = [p for p in existing.split(":") if p]
        existing_set = set(existing_parts)
        new_parts = [d for d in dirs if d not in existing_set]
        remaining = [p for p in existing_parts if p not in set(new_parts)]
        os.environ["LD_LIBRARY_PATH"] = ":".join(new_parts + remaining)
    return {"ok": bool(dirs), "dirs": dirs, "missing": missing, "error": error}


__all__ = ["setup_cuda_dll_paths", "CudaSetupResult"]

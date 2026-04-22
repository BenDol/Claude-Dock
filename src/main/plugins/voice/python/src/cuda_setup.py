"""Early CUDA DLL / shared-library path setup.

`faster-whisper` delegates to `ctranslate2`, which eagerly loads CUDA
libraries (`cublas`, `cudnn`) on import when `device='cuda'` or `'auto'`.

On Python 3.8+ Windows the DLL search path no longer includes PATH for
dynamically loaded libraries — callers must register directories with
`os.add_dll_directory()`. Without that, ctranslate2 fails to find
`cudnn_ops_infer64_9.dll` / `cublas64_12.dll` and raises a generic
"Library not found" error, even when the files are sitting in a
`site-packages/nvidia/*/bin` directory.

The `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` PyPI wheels ship those
DLLs under `site-packages/nvidia/cublas/bin/` and `nvidia/cudnn/bin/` on
Windows (and `.so` files under `nvidia/<pkg>/lib/` on Linux). This module
registers those directories so ctranslate2 can dlopen them.

Call `setup_cuda_dll_paths()` BEFORE importing `faster_whisper` or
`ctranslate2`. Calling it is a no-op when the nvidia packages aren't
installed — the user has opted out of GPU acceleration and we should
stay on the CPU path without side effects.
"""

import os
import sys
from typing import List, Optional, TypedDict


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

        base = os.path.dirname(getattr(mod, "__file__", "") or "")
        if not base:
            missing.append(pkg.rsplit(".", 1)[-1])
            continue

        dll_dir = _find_dll_dir(base)
        if not dll_dir:
            missing.append(pkg.rsplit(".", 1)[-1])
            continue

        try:
            os.add_dll_directory(dll_dir)  # type: ignore[attr-defined]
            dirs.append(dll_dir)
        except (OSError, FileNotFoundError) as exc:
            # Keep the first error so callers can surface it; continue with
            # the other packages — partial setup is still better than none.
            if error is None:
                error = f"{pkg}: {exc}"
    return {"ok": bool(dirs), "dirs": dirs, "missing": missing, "error": error}


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

        base = os.path.dirname(getattr(mod, "__file__", "") or "")
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

from __future__ import annotations

import os
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None


class FileLock:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = None

    def acquire(self, timeout: float = 5.0) -> bool:
        self._file = open(self.path, "a+", encoding="utf-8")
        if fcntl is not None:
            fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True

        # Windows fallback: use msvcrt byte-range lock on first byte.
        import msvcrt

        self._file.seek(0)
        if self._file.read(1) == "":
            self._file.write(" ")
            self._file.flush()
        self._file.seek(0)
        msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
        return True

    def release(self) -> None:
        if self._file is None:
            return
        try:
            if fcntl is not None:
                fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
            else:
                import msvcrt

                self._file.seek(0)
                msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
        except Exception:
            pass
        finally:
            self._file.close()
            self._file = None

    def __enter__(self):
        if not self.acquire():
            raise TimeoutError(f"无法获取锁: {self.path}")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.release()

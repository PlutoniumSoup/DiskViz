from flask import Flask, render_template, jsonify, request, Response
from pathlib import Path
import os
import sys
import shutil
import atexit
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import threading

app = Flask(__name__)
size_cache = {}
size_cache_lock = threading.Lock()
NO_ACCESS = -1  # размер папки при отсутствии доступа (PermissionError)
_executor = ThreadPoolExecutor(max_workers=8)

# Файл кэша размеров (рядом с приложением или в текущей папке)
_CACHE_FILE = Path(__file__).resolve().parent / "diskviz_cache.json"


def _normalize_path_for_cache(p: str) -> str:
    return str(Path(p).resolve()).rstrip("\\")


def load_cache():
    """Загрузить кэш размеров с диска при старте."""
    global size_cache
    if not _CACHE_FILE.exists():
        return
    try:
        with open(_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        with size_cache_lock:
            size_cache.update(data)
    except (json.JSONDecodeError, OSError):
        pass


def save_cache():
    """Сохранить кэш размеров на диск."""
    with size_cache_lock:
        data = dict(size_cache)
    try:
        with open(_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except OSError:
        pass


def clear_cache_for_path(path: Path):
    """Удалить из кэша путь, все вложенные и всех предков (для пересканирования)."""
    p = path.resolve()
    keys_to_delete = set()
    with size_cache_lock:
        for cur in [p, *p.parents]:
            base = _normalize_path_for_cache(str(cur))
            prefix = base + "\\"
            for k in list(size_cache.keys()):
                if k == base or k.startswith(prefix):
                    keys_to_delete.add(k)
        for k in keys_to_delete:
            del size_cache[k]

# На Windows junction не считается is_symlink(), а os.path.isjunction есть только в 3.12+
FILE_ATTRIBUTE_REPARSE_POINT = 0x400

def _is_junction_or_symlink(path: Path) -> bool:
    """Папка-ссылка (junction/symlink): не считаем размер, чтобы не дублировать данные."""
    try:
        if path.is_symlink():
            return True
        if hasattr(os.path, "isjunction") and os.path.isjunction(str(path)):
            return True
        # Windows, Python < 3.12: junction не даёт is_symlink(), проверяем reparse point по атрибутам
        if sys.platform == "win32" and path.is_dir():
            try:
                import ctypes
                k32 = ctypes.windll.kernel32
                attrs = k32.GetFileAttributesW(str(path.resolve()))
                if attrs != 0xFFFFFFFF and (attrs & FILE_ATTRIBUTE_REPARSE_POINT):
                    return True
            except (OSError, AttributeError):
                pass
    except OSError:
        pass
    return False

def human_readable(size_bytes):
    if size_bytes is None or size_bytes == NO_ACCESS or size_bytes < 0:
        return None  # вызывающий код покажет «нет доступа»
    if size_bytes == 0:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    i = 0
    while size_bytes >= 1024 and i < len(units) - 1:
        size_bytes /= 1024
        i += 1
    return f"{size_bytes:.1f} {units[i]}"

def get_folder_size(path: Path) -> int:
    pstr = str(path.resolve())
    with size_cache_lock:
        if pstr in size_cache:
            return size_cache[pstr]
    if path.is_file():
        try:
            size = path.stat().st_size
            with size_cache_lock:
                size_cache[pstr] = size
            return size
        except (PermissionError, FileNotFoundError, OSError):
            with size_cache_lock:
                size_cache[pstr] = NO_ACCESS
            return NO_ACCESS
    if _is_junction_or_symlink(path):
        with size_cache_lock:
            size_cache[pstr] = 0
        return 0
    try:
        size = 0
        for entry in os.scandir(path):
            entry_path = Path(entry.path)
            if entry.is_dir(follow_symlinks=False):
                if _is_junction_or_symlink(entry_path):
                    continue
                child_size = get_folder_size(entry_path)
                size += child_size if child_size != NO_ACCESS else 0
            else:
                try:
                    size += entry.stat().st_size
                except (PermissionError, OSError):
                    pass
        with size_cache_lock:
            size_cache[pstr] = size
        return size
    except PermissionError:
        with size_cache_lock:
            size_cache[pstr] = NO_ACCESS
        return NO_ACCESS
    except (FileNotFoundError, OSError):
        with size_cache_lock:
            size_cache[pstr] = 0
        return 0

@app.route("/")
def home():
    return render_template("index.html")

@app.route("/api/drives")
def get_drives():
    drives = []
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        root = f"{letter}:\\"
        if os.path.isdir(root):
            try:
                usage = shutil.disk_usage(root)
                drives.append({
                    "letter": letter,
                    "path": root,
                    "total_hr": human_readable(usage.total),
                    "used_hr": human_readable(usage.used),
                    "free_hr": human_readable(usage.free),
                    "percent_used": round((usage.used / usage.total) * 100, 1)
                })
            except:
                pass
    return jsonify(drives)

def _stream_list(path: Path):
    """Генератор SSE: meta, затем item по одному, затем update для папок, затем end."""
    try:
        drive_root = str(path.anchor)
        usage = shutil.disk_usage(drive_root)
        disk_usage = {
            "total_hr": human_readable(usage.total),
            "used_hr": human_readable(usage.used),
            "free_hr": human_readable(usage.free),
            "percent": round((usage.used / usage.total) * 100, 1),
        }
        parent_path = str(path.parent) if str(path.parent) != str(path) else None
        yield f"data: {json.dumps({'type': 'meta', 'current_path': str(path), 'parent_path': parent_path, 'disk_usage': disk_usage})}\n\n"

        entries = list(os.scandir(path))
        items_by_index = {}
        pending_dirs = []

        for idx, entry in enumerate(entries):
            entry_path = Path(entry.path)
            is_dir = entry.is_dir()
            try:
                mtime = entry.stat().st_mtime
                modified = datetime.fromtimestamp(mtime).strftime("%d.%m.%Y %H:%M")
            except (PermissionError, OSError):
                modified = "—"
            item_type = "Папка" if is_dir else (entry_path.suffix or "Файл")
            is_link = is_dir and _is_junction_or_symlink(entry_path)

            if is_dir:
                if is_link:
                    raw_size = 0
                    size_hr = "ссылка"
                    no_access = False
                else:
                    raw_size = None
                    size_hr = "…"
                    no_access = False
                    fut = _executor.submit(get_folder_size, entry_path)
                    pending_dirs.append((idx, fut, str(entry_path.resolve())))
            else:
                try:
                    raw_size = entry.stat().st_size
                except (PermissionError, OSError):
                    raw_size = 0
                size_hr = human_readable(raw_size) if raw_size != NO_ACCESS else "нет доступа"
                no_access = raw_size == NO_ACCESS

            size = 0 if raw_size is None or raw_size == NO_ACCESS else (raw_size or 0)
            item = {
                "index": idx,
                "name": entry.name,
                "full_path": str(entry_path),
                "is_dir": is_dir,
                "size": size,
                "raw_size": raw_size if raw_size is not None else 0,
                "size_hr": size_hr,
                "no_access": no_access,
                "is_link": is_link,
                "modified": modified,
                "type": item_type,
            }
            items_by_index[idx] = item
            yield f"data: {json.dumps({'type': 'item', 'item': item})}\n\n"

        for idx, fut, scan_path in pending_dirs:
            yield f"data: {json.dumps({'type': 'scanning', 'path': scan_path})}\n\n"
            try:
                raw_size = fut.result()
            except Exception:
                raw_size = NO_ACCESS
            size = 0 if raw_size == NO_ACCESS else raw_size
            size_hr = "нет доступа" if raw_size == NO_ACCESS else human_readable(raw_size)
            items_by_index[idx]["size"] = size
            items_by_index[idx]["raw_size"] = raw_size
            items_by_index[idx]["size_hr"] = size_hr
            items_by_index[idx]["no_access"] = raw_size == NO_ACCESS
            yield f"data: {json.dumps({'type': 'update', 'index': idx, 'size': size, 'size_hr': size_hr, 'no_access': raw_size == NO_ACCESS})}\n\n"

        save_cache()
        items_sorted = sorted(
            items_by_index.values(),
            key=lambda x: (x["raw_size"] == NO_ACCESS, -(x["size"] or 0)),
            reverse=False,
        )
        top_folders = [x for x in items_sorted if x["is_dir"] and x.get("raw_size", x["size"]) != NO_ACCESS and not x.get("is_link")][:8]
        current_raw = get_folder_size(path)
        current_size_hr = human_readable(current_raw) if current_raw != NO_ACCESS else "нет доступа"
        yield f"data: {json.dumps({'type': 'end', 'current_size_hr': current_size_hr, 'top_folders': top_folders, 'items_order': [x['index'] for x in items_sorted]})}\n\n"
    except Exception as e:
        yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"


@app.route("/api/list/stream")
def list_dir_stream():
    path_str = request.args.get("path", "C:\\")
    refresh = request.args.get("refresh", "").lower() in ("1", "true", "yes")
    path = Path(path_str).resolve()
    if not path.exists() or not path.is_dir():
        return jsonify({"error": "Путь не существует или не папка"})
    if refresh:
        clear_cache_for_path(path)
    return Response(
        _stream_list(path),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/list")
def list_dir():
    path_str = request.args.get("path", "C:\\")
    try:
        path = Path(path_str).resolve()
        if not path.exists() or not path.is_dir():
            return jsonify({"error": "Путь не существует или не папка"})

        items = []
        for entry in os.scandir(path):
            entry_path = Path(entry.path)
            is_dir = entry.is_dir()
            is_link = is_dir and _is_junction_or_symlink(entry_path)
            if is_link:
                raw_size = 0
                size_hr = "ссылка"
            else:
                if is_dir:
                    raw_size = get_folder_size(entry_path)
                else:
                    try:
                        raw_size = entry.stat().st_size
                    except (PermissionError, OSError):
                        raw_size = 0
                size_hr = human_readable(raw_size) if raw_size != NO_ACCESS else "нет доступа"
            size = raw_size if raw_size != NO_ACCESS else 0
            try:
                modified = datetime.fromtimestamp(entry.stat().st_mtime).strftime("%d.%m.%Y %H:%M")
            except (PermissionError, OSError):
                modified = "—"
            items.append({
                "name": entry.name,
                "full_path": str(entry_path),
                "is_dir": is_dir,
                "size": size,
                "raw_size": raw_size if raw_size != NO_ACCESS else 0,
                "size_hr": size_hr,
                "no_access": raw_size == NO_ACCESS,
                "is_link": is_link,
                "modified": modified,
                "type": "Папка" if is_dir else (entry_path.suffix or "Файл")
            })

        items.sort(key=lambda x: (x["raw_size"] == NO_ACCESS, -(x["size"] or 0)), reverse=False)
        current_raw = get_folder_size(path)

        drive_root = str(path.anchor)
        usage = shutil.disk_usage(drive_root)
        disk_usage = {
            "total_hr": human_readable(usage.total),
            "used_hr": human_readable(usage.used),
            "free_hr": human_readable(usage.free),
            "percent": round((usage.used / usage.total) * 100, 1)
        }

        top_folders = [f for f in items if f["is_dir"] and f.get("raw_size", f["size"]) != NO_ACCESS and not f.get("is_link")][:8]

        return jsonify({
            "items": items,
            "current_path": str(path),
            "current_size_hr": human_readable(current_raw) if current_raw != NO_ACCESS else "нет доступа",
            "disk_usage": disk_usage,
            "top_folders": top_folders,
            "parent_path": str(path.parent) if str(path.parent) != str(path) else None
        })
    except Exception as e:
        return jsonify({"error": str(e)})

@app.route("/api/largest")
def get_largest():
    path_str = request.args.get("path", "C:\\")
    limit = int(request.args.get("limit", 30))
    path = Path(path_str)
    large_files = []
    for dirpath, _, filenames in os.walk(path):
        for filename in filenames:
            file_path = Path(dirpath) / filename
            try:
                size = file_path.stat().st_size
                if size > 0:
                    large_files.append({
                        "name": filename,
                        "full_path": str(file_path),
                        "size": size,
                        "size_hr": human_readable(size),
                        "rel_path": str(file_path.relative_to(path))
                    })
            except:
                pass
    large_files.sort(key=lambda x: x["size"], reverse=True)
    return jsonify(large_files[:limit])

atexit.register(save_cache)
load_cache()

if __name__ == "__main__":
    print("🚀 DiskViz — открой http://127.0.0.1:5000")
    app.run(debug=True)
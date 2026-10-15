"""Registro de impresiones 3D.

Servidor local mínimo (solo librería estándar). Guarda cada impresión en
data/impresiones/<id>/datos.json junto con sus fotos.

Uso:  python app.py   (abre http://127.0.0.1:8765 en el navegador)
"""

import copy
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import unicodedata
import webbrowser
import zipfile
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HOST = "127.0.0.1"
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8765

BASE = Path(__file__).resolve().parent
CONFIG_FILE = BASE / "config" / "campos.json"
PUBLIC_DIR = BASE / "public"
DATA_DIR = BASE / "data" / "impresiones"
TRASH_DIR = BASE / "data" / "papelera"
CATALOG_DIR = BASE / "data" / "catalogos"
REGISTER_DIR = BASE / "data" / "registros"
DATA_ROOT = BASE / "data"
SETTINGS_FILE = DATA_ROOT / "ajustes.json"
DEFAULT_BACKUP_DIR = BASE / "copias"
BACKUP_PREFIX = "impresiones3d-"
DATA_FILE = "datos.json"

# Ajustes de la configuración general (se guardan en data/ajustes.json)
DEFAULT_SETTINGS = {
    "copias": {"carpeta": "", "conservar": 10, "automatica": True},
    # El consumo, el precio y la vida útil de cada máquina están en el catálogo de Máquinas.
    "costes": {
        "activo": False,
        "precioKWh": 0.20,          # €/kWh
        "postprocesadoHora": None,  # €/h de pintura, montaje, acabados
        "disenoHora": None,         # €/h de diseño
    },
    # Tasa de fallos por tipo: % por defecto y si la casilla viene marcada en las impresiones nuevas
    "fallos": {
        "disenoPct": None, "disenoMarcada": False,                # rehacer el diseño
        "generalPct": None, "generalMarcada": False,              # repetir toda la impresión
        "placaPct": None, "placaMarcada": False,                  # repetir una placa concreta
        "postprocesadoPct": None, "postprocesadoMarcada": False,  # piezas rotas al pintar o montar
    },
}
PHOTOS_DIR = "fotos"

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,120}$")
PHOTO_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_UPLOAD = 25 * 1024 * 1024


# ---------------------------------------------------------------- utilidades

def slugify(text):
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:60] or "impresion"


def safe_filename(name):
    name = Path(name).name
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    stem = re.sub(r"[^a-zA-Z0-9_-]+", "-", unicodedata.normalize("NFKD", stem)
                  .encode("ascii", "ignore").decode()).strip("-") or "foto"
    return stem[:60], ext


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def print_dir(pid):
    if not ID_RE.match(pid):
        raise ValueError("id no válido")
    return DATA_DIR / pid


def list_photos(folder):
    photos_dir = folder / PHOTOS_DIR
    if not photos_dir.is_dir():
        return []
    return sorted(p.name for p in photos_dir.iterdir()
                  if p.is_file() and p.suffix.lower() in PHOTO_EXT)


def load_print(pid):
    folder = print_dir(pid)
    file = folder / DATA_FILE
    if not file.is_file():
        return None
    data = json.loads(file.read_text(encoding="utf-8-sig"))
    data["id"] = pid
    data["fotos"] = list_photos(folder)
    return data


def save_print(pid, data):
    folder = print_dir(pid)
    folder.mkdir(parents=True, exist_ok=True)
    data = {k: v for k, v in data.items() if k not in ("id", "fotos")}
    write_json(folder / DATA_FILE, data)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


# Listas guardadas en un único JSON: catálogos (impresoras, accesorios, tipos de
# gasto…) y registros (gastos…). Se definen en config/campos.json.
LIST_DIRS = {"catalogos": CATALOG_DIR, "registros": REGISTER_DIR}


def list_file(kind, lid):
    """Ruta del JSON de la lista; si no existe, la crea con los valores iniciales."""
    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig"))
    defs = {d["id"]: d for d in config.get(kind, [])}
    if lid not in defs:
        raise ValueError("Lista desconocida")
    file = LIST_DIRS[kind] / f"{lid}.json"
    if not file.is_file():
        write_json(file, defs[lid].get("inicial", []))
    return file


def load_list(kind, lid):
    return json.loads(list_file(kind, lid).read_text(encoding="utf-8-sig"))


def open_field(data, campo, folder=False):
    """Abre la ruta local guardada en data[campo] (campo con puntos: "general.enlace")."""
    value = data
    for key in str(campo or "").split("."):
        value = value.get(key) if isinstance(value, dict) else None
    if not isinstance(value, str) or not value.strip():
        raise ValueError("No hay ninguna ruta guardada en ese campo")
    path = Path(value.strip().strip('"'))
    if not path.exists():
        raise FileNotFoundError(f"No se encuentra: {path}")
    open_local(path, folder)


# ------------------------------------------------------------------ ajustes

def load_settings():
    """Ajustes guardados, completados con los valores por defecto."""
    settings = copy.deepcopy(DEFAULT_SETTINGS)
    if SETTINGS_FILE.is_file():
        saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8-sig"))
        for section, values in saved.items():
            if isinstance(values, dict) and section in settings:
                settings[section].update(values)
    return settings


def clean_settings(data):
    """Valida los ajustes recibidos: solo claves conocidas y tipos correctos."""
    out = copy.deepcopy(DEFAULT_SETTINGS)
    for section, defaults in DEFAULT_SETTINGS.items():
        values = data.get(section) or {}
        if not isinstance(values, dict):
            raise ValueError(f"Ajustes no válidos: {section}")
        for key in defaults:
            if key not in values:
                continue
            v = values[key]
            if key in ("activo", "automatica") or key.endswith("Marcada"):
                out[section][key] = bool(v)
            elif key == "carpeta":
                out[section][key] = str(v or "").strip().strip('"')
            elif key == "conservar":
                out[section][key] = max(1, min(365, int(v or 1)))
            else:  # números opcionales
                if v in (None, ""):
                    out[section][key] = None
                else:
                    num = float(v)
                    if num < 0:
                        raise ValueError(f"El valor de {key} no puede ser negativo")
                    out[section][key] = num
    return out


# ---------------------------------------------------------- copias de seguridad

def backup_dir(settings=None):
    settings = settings or load_settings()
    folder = settings["copias"]["carpeta"]
    path = Path(folder).expanduser() if folder else DEFAULT_BACKUP_DIR
    if not path.is_absolute():
        path = BASE / path
    path = path.resolve()
    if path == DATA_ROOT.resolve() or DATA_ROOT.resolve() in path.parents:
        raise ValueError("La carpeta de copias no puede estar dentro de la carpeta data")
    return path


def list_backups(settings=None):
    folder = backup_dir(settings)
    if not folder.is_dir():
        return []
    items = []
    for f in sorted(folder.glob(f"{BACKUP_PREFIX}*.zip"), reverse=True):
        st = f.stat()
        items.append({"nombre": f.name, "bytes": st.st_size,
                      "fecha": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")})
    return items


_backup_lock = threading.Lock()


def make_backup(settings=None):
    """Comprime data/ (y la configuración de campos) en un .zip fechado y borra las copias más antiguas."""
    settings = settings or load_settings()
    folder = backup_dir(settings)
    with _backup_lock:
        folder.mkdir(parents=True, exist_ok=True)
        name = f"{BACKUP_PREFIX}{datetime.now():%Y%m%d-%H%M%S}.zip"
        tmp = folder / (name + ".tmp")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for path in sorted(DATA_ROOT.rglob("*")):
                if path.is_file() and not path.name.endswith(".tmp"):
                    z.write(path, Path("data") / path.relative_to(DATA_ROOT))
            if CONFIG_FILE.is_file():
                z.write(CONFIG_FILE, Path("config") / CONFIG_FILE.name)
        tmp.replace(folder / name)
        # Conservar solo las N más recientes (únicamente ficheros creados por la app)
        keep = settings["copias"]["conservar"]
        for old in sorted(folder.glob(f"{BACKUP_PREFIX}*.zip"), reverse=True)[keep:]:
            old.unlink()
    return {"nombre": name, "carpeta": str(folder)}


def auto_backup():
    """Copia automática al arrancar, como mucho una al día."""
    try:
        settings = load_settings()
        if not settings["copias"]["automatica"]:
            return
        today = f"{BACKUP_PREFIX}{datetime.now():%Y%m%d}-"
        if any(b["nombre"].startswith(today) for b in list_backups(settings)):
            return
        result = make_backup(settings)
        print(f"Copia de seguridad creada: {Path(result['carpeta']) / result['nombre']}")
    except Exception as e:  # noqa: BLE001 - no debe impedir arrancar la app
        print(f"AVISO: no se pudo hacer la copia de seguridad automática: {e}")


def open_local(path, folder=False):
    """Abre un fichero con su programa asociado, o su carpeta en el explorador."""
    if sys.platform == "win32":
        if folder:
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(str(path))  # noqa: S606 (ruta guardada por el usuario)
    else:
        target = path.parent if folder else path
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(target)])


def new_id(data):
    nombre = (data.get("general") or {}).get("nombre") or "impresion"
    base = f"{datetime.now():%Y%m%d}-{slugify(nombre)}"
    pid, n = base, 2
    while (DATA_DIR / pid).exists():
        pid, n = f"{base}-{n}", n + 1
    return pid


# ------------------------------------------------------------------ servidor

class Handler(BaseHTTPRequestHandler):
    server_version = "Impresiones3D/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    # -- respuestas
    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message):
        self.send_json({"error": message}, status)

    def send_file(self, path):
        if not path.is_file():
            return self.send_error_json(HTTPStatus.NOT_FOUND, "No encontrado")
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD:
            raise ValueError("Fichero demasiado grande")
        return self.rfile.read(length) if length else b""

    def read_json(self):
        body = self.read_body()
        return json.loads(body.decode("utf-8")) if body else {}

    # -- enrutado
    def route(self, method):
        url = urlparse(self.path)
        parts = [unquote(p) for p in url.path.strip("/").split("/") if p]
        # Solo se aceptan peticiones dirigidas a este servidor local (evita DNS rebinding)…
        host = (self.headers.get("Host") or "").lower()
        if host not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
            return self.send_error_json(HTTPStatus.FORBIDDEN, "Host no permitido")
        # …y los cambios solo desde la propia app: la cabecera personalizada obliga
        # al navegador a pedir permiso (CORS) a otras webs, y este servidor no lo concede.
        if method != "GET" and self.headers.get("X-App") != "impresiones-3d":
            return self.send_error_json(HTTPStatus.FORBIDDEN, "Petición no permitida")
        try:
            if parts[:1] == ["api"]:
                return self.api(method, parts[1:], parse_qs(url.query))
            if method != "GET":
                return self.send_error_json(HTTPStatus.METHOD_NOT_ALLOWED, "Método no permitido")
            if parts[:1] == ["fotos"] and len(parts) == 3:
                pid, name = parts[1], Path(parts[2]).name
                return self.send_file(print_dir(pid) / PHOTOS_DIR / name)
            target = (PUBLIC_DIR / "/".join(parts)).resolve() if parts else PUBLIC_DIR / "index.html"
            if PUBLIC_DIR not in target.parents and target != PUBLIC_DIR / "index.html":
                return self.send_error_json(HTTPStatus.FORBIDDEN, "Prohibido")
            return self.send_file(target)
        except FileNotFoundError as e:
            return self.send_error_json(HTTPStatus.NOT_FOUND, str(e))
        except ValueError as e:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        except Exception as e:  # noqa: BLE001
            self.log_message("ERROR %r", e)
            return self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))

    def api(self, method, parts, query):
        if parts == ["config"] and method == "GET":
            return self.send_file(CONFIG_FILE)

        # /api/ajustes  (configuración general)
        if parts == ["ajustes"]:
            if method == "GET":
                return self.send_json({**load_settings(), "carpetaPorDefecto": str(DEFAULT_BACKUP_DIR)})
            if method == "PUT":
                settings = clean_settings(self.read_json())
                backup_dir(settings)  # valida la carpeta
                write_json(SETTINGS_FILE, settings)
                return self.send_json({**settings, "carpetaPorDefecto": str(DEFAULT_BACKUP_DIR)})

        # /api/copias  (copias de seguridad)
        if parts == ["copias"]:
            if method == "GET":
                return self.send_json({"carpeta": str(backup_dir()), "copias": list_backups()})
            if method == "POST":
                return self.send_json(make_backup(), HTTPStatus.CREATED)
        if parts == ["copias", "abrir"] and method == "POST":
            folder = backup_dir()
            folder.mkdir(parents=True, exist_ok=True)
            open_local(folder)
            return self.send_json({"ok": True})

        # /api/catalogos/<id>  y  /api/registros/<id>
        if parts[:1] and parts[0] in LIST_DIRS and len(parts) == 2:
            kind, lid = parts
            if method == "GET":
                return self.send_json(load_list(kind, lid))
            if method == "PUT":
                file = list_file(kind, lid)
                items = self.read_json()
                if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
                    raise ValueError("Se esperaba una lista de elementos")
                previous = load_list(kind, lid)
                if len(items) < len(previous):
                    # Se ha borrado algo: guardamos copia de la versión anterior.
                    backup = TRASH_DIR / kind / f"{lid}-{datetime.now():%Y%m%d%H%M%S}.json"
                    write_json(backup, previous)
                write_json(file, items)
                return self.send_json(items)

        # /api/registros/<id>/<elemento>/abrir  {"campo": "enlace", "carpeta": false}
        if parts[:1] == ["registros"] and len(parts) == 4 and parts[3] == "abrir" and method == "POST":
            item = next((i for i in load_list("registros", parts[1]) if i.get("id") == parts[2]), None)
            if item is None:
                return self.send_error_json(HTTPStatus.NOT_FOUND, "Elemento no encontrado")
            body = self.read_json()
            open_field(item, body.get("campo"), bool(body.get("carpeta")))
            return self.send_json({"ok": True})

        if parts[:1] != ["impresiones"]:
            return self.send_error_json(HTTPStatus.NOT_FOUND, "Ruta desconocida")

        # /api/impresiones
        if len(parts) == 1:
            if method == "GET":
                items = []
                if DATA_DIR.is_dir():
                    for folder in DATA_DIR.iterdir():
                        if folder.is_dir() and ID_RE.match(folder.name):
                            try:
                                item = load_print(folder.name)
                            except (OSError, json.JSONDecodeError) as e:
                                self.log_message("No se pudo leer %s: %r", folder.name, e)
                                continue
                            if item:
                                items.append(item)
                return self.send_json(items)
            if method == "POST":
                data = self.read_json()
                pid = new_id(data)
                data["creado"] = data["modificado"] = now_iso()
                save_print(pid, data)
                return self.send_json(load_print(pid), HTTPStatus.CREATED)

        pid = parts[1]
        folder = print_dir(pid)

        # /api/impresiones/<id>
        if len(parts) == 2:
            current = load_print(pid)
            if current is None:
                return self.send_error_json(HTTPStatus.NOT_FOUND, "Impresión no encontrada")
            if method == "GET":
                return self.send_json(current)
            if method == "PUT":
                data = self.read_json()
                data["creado"] = current.get("creado") or now_iso()
                data["modificado"] = now_iso()
                save_print(pid, data)
                return self.send_json(load_print(pid))
            if method == "DELETE":
                # No se borra: se mueve a la papelera.
                TRASH_DIR.mkdir(parents=True, exist_ok=True)
                dest = TRASH_DIR / f"{pid}-{datetime.now():%Y%m%d%H%M%S}"
                shutil.move(str(folder), str(dest))
                return self.send_json({"ok": True})

        # /api/impresiones/<id>/abrir  {"campo": "general.enlace", "carpeta": false}
        # Solo abre rutas que ya están guardadas en la impresión.
        if len(parts) == 3 and parts[2] == "abrir" and method == "POST":
            current = load_print(pid)
            if current is None:
                return self.send_error_json(HTTPStatus.NOT_FOUND, "Impresión no encontrada")
            body = self.read_json()
            open_field(current, body.get("campo"), bool(body.get("carpeta")))
            return self.send_json({"ok": True})

        # /api/impresiones/<id>/fotos[/<nombre>]
        if len(parts) >= 3 and parts[2] == "fotos":
            if load_print(pid) is None:
                return self.send_error_json(HTTPStatus.NOT_FOUND, "Impresión no encontrada")
            photos_dir = folder / PHOTOS_DIR
            if len(parts) == 3 and method == "POST":
                stem, ext = safe_filename((query.get("nombre") or ["foto.jpg"])[0])
                if ext not in PHOTO_EXT:
                    raise ValueError("Formato de imagen no admitido")
                body = self.read_body()
                if not body:
                    raise ValueError("Fichero vacío")
                photos_dir.mkdir(parents=True, exist_ok=True)
                name, n = f"{stem}{ext}", 2
                while (photos_dir / name).exists():
                    name, n = f"{stem}-{n}{ext}", n + 1
                (photos_dir / name).write_bytes(body)
                return self.send_json({"nombre": name}, HTTPStatus.CREATED)
            if len(parts) == 4 and method == "DELETE":
                photo = photos_dir / Path(parts[3]).name
                if not photo.is_file():
                    return self.send_error_json(HTTPStatus.NOT_FOUND, "Foto no encontrada")
                trash = TRASH_DIR / "fotos" / pid
                trash.mkdir(parents=True, exist_ok=True)
                shutil.move(str(photo), str(trash / f"{datetime.now():%Y%m%d%H%M%S}-{photo.name}"))
                return self.send_json({"ok": True})

        return self.send_error_json(HTTPStatus.NOT_FOUND, "Ruta desconocida")

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"Registro de impresiones 3D en {url}  (Ctrl+C para salir)")
    if "--sin-copia" not in sys.argv:
        threading.Thread(target=auto_backup, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

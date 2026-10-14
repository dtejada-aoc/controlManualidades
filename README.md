# Registro de impresiones 3D

Aplicación local para registrar impresiones 3D: placas, filamento, costes, accesorios, pintura y fotos.

Funciona en local, sin base de datos (todo se guarda en ficheros JSON) y sin dependencias externas.

## Requisitos

- [Python 3.9 o superior](https://www.python.org/downloads/) (solo la librería estándar).
- Un navegador moderno (Chrome, Edge, Firefox).

## Instalación y arranque

```bash
git clone https://github.com/dtejada-aoc/controlManualidades.git
cd controlManualidades
python app.py
```

En Windows también puedes hacer doble clic en `iniciar.bat`. Se abre http://127.0.0.1:8765 en el navegador.
La primera vez la app arranca vacía y crea la carpeta `data/` con los catálogos iniciales.

El servidor solo escucha en `127.0.0.1` (no es accesible desde otros equipos) y solo acepta cambios hechos desde la propia app.

## Pantallas

- **Impresiones**: listado con totales; cada ficha muestra producción y filamento. Cada placa lleva
  uno o varios **filamentos** con sus gramos (modelo y desperdicio); el coste de material se calcula
  con el precio por kg del filamento (copiado al elegirlo, para que no cambie si luego varía el precio).
- **Filamentos**: bobinas con nombre, marca, tipo, color (con muestra opcional) y precio por kg.
- **Gastos**: compras de material de apoyo (bobinas, recambios, limpieza…) con desglose por tipo y año.
  Es solo control del gasto: no se resta de los beneficios de las impresiones (el filamento ya se cuenta en el coste de cada placa).
- **Ventas**: registro aparte (no se mezcla con las impresiones). Cada venta indica la impresión vendida,
  unidades, precio por unidad y coste por unidad (se copia de la impresión y se puede ajustar).
- **Informes**: resumen general, gastos, producción y ventas, con filtro por año y botón
  **Exportar PDF** (usa la impresión del navegador: elige «Guardar como PDF» / «Microsoft Print to PDF»).
  Cada impresión también tiene botón **PDF** para exportar su ficha.
- **Configuración**:
  - *Copias de seguridad*: carpeta de destino (p. ej. una carpeta en la nube), copias a conservar y copia
    automática al arrancar (una al día como máximo). Cada copia es un .zip fechado con `data/` y `config/campos.json`.
  - *Costes reales*: precio del kWh, postprocesado (€/h sobre pintura y montaje) y diseño (€/h).
    La electricidad y la amortización salen de la **máquina de cada placa** (catálogo Máquinas: consumo en W,
    precio y vida útil en horas). Cada impresión muestra su **coste real**.
- **Catálogos**: máquinas (impresoras 3D, láser…, una marcada por defecto, con consumo, precio y vida útil), accesorios con su precio por unidad, tipos de gasto y tipos de filamento
  (se eligen en la ficha de cada filamento).

## Cómo se calcula

- **Coste por unidad** = coste total ÷ unidades obtenidas.
- **Beneficio de una venta** = unidades × (precio de venta − coste por unidad). Cada unidad vendida
  cuenta como una pieza impresa: si vendes 20, el coste es el de imprimir 20.
- El precio de un accesorio se copia del catálogo al elegirlo: si luego cambias el precio
  en el catálogo, las impresiones anteriores conservan el suyo.

## Dónde se guardan los datos

```
data/impresiones/<id>/datos.json   ← datos de la impresión
data/impresiones/<id>/fotos/       ← fotos
data/catalogos/*.json              ← impresoras, accesorios y tipos de gasto
data/registros/filamentos.json     ← filamentos
data/registros/gastos.json         ← gastos
data/registros/ventas.json         ← ventas
data/ajustes.json                  ← configuración general
data/papelera/                     ← lo que eliminas desde la app (recuperable)
copias/                            ← copias de seguridad (carpeta por defecto)
```

Para restaurar una copia, descomprime el .zip en la carpeta de la app (sobrescribe `data/`). Esta carpeta está en `.gitignore`:
tus datos nunca se suben al repositorio.

## Personalizar campos: `config/campos.json`

- `secciones`: bloques del formulario. Con `"repetible": true` se pueden añadir varios elementos (placas, accesorios…).
- `campos`: cada campo tiene `id`, `etiqueta` y `tipo`:
  `texto`, `textoLargo`, `numero` (con `unidad` opcional), `moneda`, `duracion` (se guarda en minutos),
  `fecha`, `seleccion` (con `opciones`), `booleano`, `enlace`, `color`, `impresion`,
  `registro` (elige un elemento de un registro, p. ej. un filamento) y `lista` (lista anidada con sus `campos`).
- `sumaDe`: campo calculado que suma campos de una lista anidada; `ceroSiFalta` en una fórmula trata esos campos vacíos como 0.
- Opciones extra: `obligatorio`, `ayuda`, `porDefecto`, `enListado` (columna en el listado).
- Tipo `catalogo` (con `"catalogo": "accesorios"`): desplegable con los elementos del catálogo;
  `rellena` copia datos del elemento elegido a la fila (ej. el precio).
- `formula`: campo calculado, p. ej. `"cantidad * precioUnidad"` (admite + - * / y paréntesis).
- `porDefecto`: valor inicial (`"hoy"` para fechas).
- `total`: suma el campo en uno o varios totales de la lista `totales` (ej. `"total": "coste"`).
- `totales` también admite `formula` (con otros totales o campos generales), `requiere`
  (solo se muestra si existen esos totales), `grupo`, `resumen` (recuadro en el listado) y `signo` (verde/rojo).
- `catalogos`: define los catálogos y sus campos; `inicial` son los elementos con los que se crean.
- `registros`: listados independientes como Gastos (`agruparPor` indica el campo del desglose).
  Para que aparezca en el menú, añade su enlace en `public/index.html`.

Para arrancar en otro puerto: `python app.py --port 8800`. Con `--sin-copia` no se hace la copia automática.

Recarga la página después de editar la configuración. Si quitas un campo, los datos antiguos no se pierden:
aparecen como "campo antiguo" en la ficha.

## Licencia

[MIT](LICENSE)

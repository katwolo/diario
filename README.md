# Diario

App de notas personal, instalable en el móvil (PWA) y que funciona sin conexión.

- **Notas, tareas, eventos, grabaciones de voz y fotos**
- **Libretas** para organizarlo todo
- **Bloc de notas** rápido en la pantalla de inicio
- **Búsqueda** y filtros por tipo
- **Copia de seguridad**: exportar / importar en JSON
- **Sincronización con Google**: el texto va a una hoja de Google Sheets y las fotos y
  grabaciones a una carpeta de tu Drive (opcional)
- **OCR gratuito**: en una nota, *Escanear texto* hace una foto y transcribe lo que pone
  (Tesseract.js, funciona en el propio móvil; la primera vez descarga unos 10 MB)

Todo se guarda primero en el dispositivo (IndexedDB), así que funciona sin conexión.
Si conectas Google, se sincroniza solo unos segundos después de cada cambio.

## Conectar con Google Sheets y Drive

1. Crea una hoja de cálculo nueva en Google Sheets (por ejemplo "Diario").
2. Crea una carpeta en Drive para las fotos y grabaciones y copia su ID: es lo que va
   después de `/folders/` en la URL de la carpeta.
3. En la hoja: **Extensiones > Apps Script**. Borra lo que haya y pega el contenido de
   [`Codigo.gs`](Codigo.gs).
4. Arriba del archivo cambia:
   - `TOKEN`: una clave larga inventada (protege tu hoja; no la compartas).
   - `FOLDER_ID`: el ID de la carpeta del paso 2.
5. Elige la función `configurar` y pulsa **Ejecutar**. Acepta los permisos.
   Se crean las pestañas *Notas* y *Libretas*.
6. **Implementar > Nueva implementación > Aplicación web**:
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
7. Copia la URL que termina en `/exec`.
8. En la app: **Más > Google Sheets y Drive**, pega la URL y la clave, y pulsa
   *Guardar y sincronizar*. Hazlo en cada móvil u ordenador que uses.

Si cambias `Codigo.gs` más adelante, usa **Implementar > Gestionar implementaciones >
Editar > Nueva versión** para que la URL siga siendo la misma.

### Cómo funciona

- Cada fila de *Notas* es una nota, tarea, evento, foto o grabación. La columna
  *Archivo* enlaza con el archivo en Drive.
- Puedes editar el texto directamente en la hoja (o añadir filas nuevas con Título y
  Contenido): los cambios llegan a la app en la siguiente sincronización.
- Si un mismo elemento se cambia en dos sitios, gana el cambio más reciente.
- Al borrar algo en la app, la fila se marca como *Borrado* (no se elimina, por si acaso)
  y su archivo pasa a la papelera de Drive.

## Probarla

Cualquier servidor estático sirve:

```sh
python3 -m http.server 8000
# abre http://localhost:8000
```

Para instalarla en el móvil hay que servirla por HTTPS (con GitHub Pages: *Settings >
Pages > Deploy from a branch*)
y elegir "Añadir a pantalla de inicio" en el navegador. La grabadora y la cámara
también necesitan HTTPS.

## Nota legal

Diario es un proyecto independiente, inspirado en el concepto general de las apps
de notas. Su código, nombre, iconos y diseño visual son propios. No usa marcas,
logotipos, código ni recursos de Evernote, y no está afiliado a Evernote Corporation.

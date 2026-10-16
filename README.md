# Diario

App de notas personal, instalable en el móvil (PWA) y que funciona sin conexión.

- **Notas, tareas, eventos, grabaciones de voz y fotos**
- **Libretas** para organizarlo todo
- **Bloc de notas** rápido en la pantalla de inicio
- **Búsqueda** y filtros por tipo
- **Copia de seguridad**: exportar / importar en JSON

Todo se guarda solo en tu dispositivo (IndexedDB). No hay servidor ni cuentas.

## Probarla

Cualquier servidor estático sirve:

```sh
python3 -m http.server 8000
# abre http://localhost:8000
```

Para instalarla en el móvil hay que servirla por HTTPS (por ejemplo con GitHub Pages)
y elegir "Añadir a pantalla de inicio" en el navegador. La grabadora y la cámara
también necesitan HTTPS.

## Nota legal

Diario es un proyecto independiente, inspirado en el concepto general de las apps
de notas. Su código, nombre, iconos y diseño visual son propios. No usa marcas,
logotipos, código ni recursos de Evernote, y no está afiliado a Evernote Corporation.

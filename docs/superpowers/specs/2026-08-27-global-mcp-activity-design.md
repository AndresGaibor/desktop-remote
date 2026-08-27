# Actividad global de MCP en `desktop-remote attach`

## Objetivo

`desktop-remote attach` debe mostrar una única actividad global con todas las operaciones MCP recibidas por el daemon, sin filtrar por el directorio desde el que se ejecuta `attach`.

## Diseño aprobado

El daemon registrará cada `operation.request` como una llamada de herramienta:

1. Emite `tool.started` antes de ejecutar la operación, usando el `requestId` como `callId`, el nombre de operación como `toolName` y los argumentos recibidos.
2. Emite `tool.completed` cuando termina correctamente, incluyendo el resultado serializado de forma segura y la duración.
3. Emite `tool.failed` cuando falla, incluyendo el mensaje acotado y la duración.

Los eventos pasan por el flujo existente del daemon: almacenamiento en memoria, persistencia en `history.jsonl`, difusión IPC a la TUI y actualización en tiempo real. El snapshot inicial seguirá cargando las últimas 50 llamadas, incluyendo las recibidas antes de abrir `attach`.

No se cambiará el socket global, el protocolo MCP, la selección por `cwd` ni la configuración de Qlik. La ruta escrita junto a `attach` no se usará como filtro.

## Compatibilidad y errores

- Las operaciones que no tengan executor seguirán devolviendo el error actual y no crearán una llamada falsa.
- Los resultados se convertirán a texto con límites mediante las reglas existentes del runtime store.
- Los eventos de llamadas MCP no se escribirán en el log operativo detallado; sí se persistirán en el historial de actividad existente.
- Se conserva el comportamiento de reconexión y sincronización snapshot + eventos pendientes.

## Verificación

- Test unitario: una operación exitosa produce `started` y `completed` y queda en el snapshot.
- Test unitario: una operación fallida produce `started` y `failed`.
- Test de regresión: el historial sigue limitado a 50 llamadas.
- Ejecutar `bun test` y `bun run typecheck` en `desktop-remote`.
- Reconstruir la instalación con `desktop-remote update-local` y comprobar `desktop-remote status`.

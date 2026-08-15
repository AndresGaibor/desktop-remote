# desktop-remote

TUI interactiva y supervisor local para **Desktop Commander Remote**.

`desktop-remote` no reemplaza ni replica la infraestructura remota de Desktop Commander. El ejecutable oficial `desktop-commander` sigue siendo responsable de autenticación, sesión, transporte, heartbeat, routing y comunicación MCP. Este proyecto se limita a ejecutar ese proceso local, interpretar sus eventos y ofrecer una experiencia de terminal más clara.

## Arquitectura

```text
ChatGPT / cliente MCP
        │
        ▼
Infraestructura oficial Desktop Commander
        │
        ▼
desktop-commander remote --persist-session
        │
        ▼
DesktopCommanderRuntime
        │
        ▼
RuntimeEvent → SessionStore → OpenTUI
                    └───────→ JSONL redactado
```

No hay servidor, Supabase, WebSocket, token refresh ni routing propio dentro de `desktop-remote`.

## Instalación

```bash
bun install
bun link
```

El proyecto fija `@wonderwhy-er/desktop-commander` a la versión validada porque el adaptador actual interpreta el formato de eventos que imprime el CLI oficial.

## Uso interactivo

```bash
desktop-remote
```

Equivale a supervisar localmente:

```bash
desktop-commander remote --persist-session
```

También puedes reenviar argumentos explícitos al CLI oficial:

```bash
desktop-remote remote --debug
desktop-remote remote --persist-session --disable-no-sleep
```

Para pruebas o wrappers personalizados:

```bash
desktop-remote --cmd /ruta/a/otro-ejecutable remote --persist-session
```

### Experiencia de la TUI

La vista principal funciona como un feed operativo en vivo: una sola lista de actividad domina la pantalla y el call más reciente queda seleccionado y visible automáticamente. Comandos y rutas largas se envuelven en varias líneas sin `…`; la selección cubre todo el bloque visual. Puedes seleccionar temporalmente una llamada antigua con teclado o click, pero la próxima llamada MCP nueva devuelve la selección al trabajo más reciente. `End` fuerza ese mismo estado de latest + auto-scroll.

El mouse usa eventos nativos de OpenTUI: un click selecciona el call completo, incluso si ocupa varias líneas, y doble click abre Detail. Al abrir una llamada con doble click o `Enter`, la inspección se congela en ese call aunque sigan llegando llamadas nuevas; `↓ N new` muestra cuántas aparecieron durante la inspección. `Esc` o `←` vuelve a Activity, selecciona el último call visible y reactiva el seguimiento.

El detalle se adapta a la tool. `read_file` muestra origen/rango y el contenido leído; `write_file` enseña exactamente el contenido que se está escribiendo; `edit_block` presenta un diff `- / +`; `start_process` separa Command de Output. El JSON crudo queda oculto por defecto y se puede mostrar con `a`. TypeScript/JavaScript/Markdown y JSON usan highlighting de OpenTUI, y tests/linters resaltan `PASS`, `FAIL`, `warning`, `error` y ubicaciones `archivo:línea:columna` semánticamente.

### Controles de la TUI

- `↑` / `↓` o `k` / `j`: navegar llamadas sin desactivar el seguimiento de nuevos calls.
- Click: seleccionar una llamada completa. Doble click: abrir Detail.
- `End`: saltar a la llamada más reciente y forzar auto-scroll al final.
- `Enter`: abrir Detail de la llamada seleccionada y congelar esa inspección.
- `Esc` o `←`: salir de Detail y volver directamente al último call.
- `a`: expandir/ocultar argumentos crudos dentro del detalle.
- `/`: buscar por tool, call ID, argumentos, resultado o error; la búsqueda muestra coincidencias `N / total`.
- `f`: alternar filtro `all → running → completed → failed`.
- `?`: abrir ayuda temporal.
- `Ctrl+C`: apagado coordinado; primero Desktop Commander, luego la TUI.

## Logging estructurado

Para persistir una sesión sin guardar secretos en claro:

```bash
desktop-remote --log-jsonl ./session.jsonl
```

Antes de escribir, el logger redacta códigos de verificación, `Authorization`, Bearer tokens, cookies, passwords, access tokens y refresh tokens dentro de estructuras anidadas.

El evento original sigue disponible en memoria para la TUI; la redacción se aplica a la copia persistida.

## Replay

Puedes abrir una sesión JSONL sin iniciar Desktop Commander ni realizar ninguna conexión remota:

```bash
desktop-remote replay ./session.jsonl
```

Esto es útil para diagnóstico, revisión de incidentes y desarrollo de renderers.

## Compatibilidad con pipes

Cuando stdin no es un TTY se conserva el formatter histórico:

```bash
desktop-commander remote --persist-session | desktop-remote
```

Opciones del modo pipe:

```bash
desktop-remote --verbose
desktop-remote --full
desktop-remote --max-lines 30
desktop-remote --save-log ./formatted.log
```

## Desarrollo

```bash
bun test
bun run typecheck
```

Las capas principales son:

```text
src/runtime/   proceso oficial + parsing a eventos tipados
src/session/   estado local independiente de la UI
src/logging/   JSONL y redacción
src/tui/       OpenTUI/Solid
src/cli/       selección de modo y compatibilidad pipe
bin/cli.ts     composición y dispatch
```

El adaptador no debe importar módulos privados como `dist/remote-device`, `RemoteChannel` o clientes Supabase de Desktop Commander.

## Estado de compatibilidad

La TUI está orientada inicialmente a macOS y Linux. El supervisor utiliza el ejecutable oficial instalado por la dependencia local y deja que Desktop Commander gestione su propio graceful shutdown.

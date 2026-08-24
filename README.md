# desktop-remote

TUI interactiva, servidor MCP propio y supervisor local para `desktop-remote`.

`desktop-remote` proporciona su propio daemon y servidor MCP local, una TUI opcional y un `tunnel-client` opcional para conectividad segura. El túnel se configura como un servicio de usuario separado.

## Arquitectura

```text
launchd / systemd --user
        │
        ▼
desktop-remote daemon
        │
        ├── supervisor ──> proceso configurado por el usuario
        ├── estado canónico (máx. 50 calls)
        ├── persistencia/logs acotados
        └── Unix socket IPC
                    │
                    ▼
             TUI opcional
```

El daemon es el proceso persistente. La TUI es un cliente desechable: abrirla o cerrarla no inicia ni detiene el daemon. No hay servidor HTTP, base de datos, token refresh ni routing propio dentro de `desktop-remote`.

## Instalación

Para desarrollo:

```bash
bun install
bun link
```

También se mantiene compatibilidad con Node.js para el daemon y comandos administrativos:

```bash
npm install
node bin/desktop-remote.js --help
```

La TUI OpenTUI requiere Bun actualmente. El daemon no carga OpenTUI y puede ejecutarse con Node.js.

Para instalar el servicio persistente del usuario:

```bash
desktop-remote install
```

`install` construye y prueba los artefactos de producción e instala un LaunchAgent en macOS o una unidad `systemd --user` en Linux/Debian. No usa `sudo`.

## Uso interactivo

```bash
desktop-remote
```

Si el servicio está en estado deseado `running`, el comando verifica que el daemon esté disponible y abre/adjunta la TUI. Si fue detenido intencionalmente, no lo resucita.

```bash
desktop-remote install
desktop-remote start
desktop-remote attach
desktop-remote status
desktop-remote restart
desktop-remote stop
desktop-remote logs
desktop-remote logs --follow
desktop-remote mcp
desktop-remote tunnel init --tunnel-id tunnel_<32 hex> --profile ./tunnel.json
desktop-remote tunnel doctor
```

`desktop-remote mcp` inicia el servidor MCP propio sobre stdio para clientes MCP. `tunnel init` valida el perfil local, lo guarda sin claves literales y genera únicamente la definición LaunchAgent/unit; no ejecuta `launchctl` ni `systemctl` ni descarga `tunnel-client`. `tunnel doctor` valida el perfil instalado sin llamar a OpenAI ni a ningún servicio remoto.

### Secure MCP Tunnel

Secure MCP Tunnel es una integración opcional: el perfil debe referenciar `env:CONTROL_PLANE_API_KEY`, nunca contener una API key literal. El túnel puede exponerse mediante el servicio de usuario generado para macOS o Linux, pero activarlo queda bajo control explícito del usuario.

`stop` es persistente hasta un `start` explícito. `restart` falla si el servicio fue detenido intencionalmente.

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
- `Ctrl+C`: cierra únicamente la TUI; el daemon sigue ejecutándose.

## Logging y persistencia

El daemon conserva como máximo las últimas 50 llamadas y las restaura después de reiniciarse. El historial persistente tiene un techo duro de 24 MiB y se compacta de forma atómica.

Los logs operativos rotan en tres archivos de hasta 2 MiB cada uno (~6 MiB total). No registran cada tool call ni heartbeat. Antes de escribir a disco se redactan códigos de verificación, Authorization/Bearer, cookies, passwords, API keys, access tokens y refresh tokens.

```bash
desktop-remote logs
desktop-remote logs --follow
```

## Replay

Puedes abrir una sesión JSONL sin iniciar ningún runtime externo ni realizar ninguna conexión remota:

```bash
desktop-remote replay ./session.jsonl
```

Esto es útil para diagnóstico, revisión de incidentes y desarrollo de renderers.

## Compatibilidad con pipes históricos

Cuando stdin no es un TTY se conserva el formatter histórico para entradas JSONL/log compatibles. Este modo no inicia ni requiere el ejecutable oficial de ningún producto externo:

```bash
mi-productor-de-eventos | desktop-remote
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

Para verificar compatibilidad con Node.js:

```bash
node bin/desktop-remote.js --help
```

Las capas principales son:

```text
src/runtime/   runtime local + parsing a eventos tipados
src/session/   estado local independiente de la UI
src/logging/   JSONL y redacción
src/tui/       OpenTUI/Solid
src/cli/       selección de modo y compatibilidad con pipes históricos
src/platform/  paths multi-OS y utilidades cross-runtime (Bun/Node)
bin/cli.ts     composición y dispatch
bin/desktop-remote.js  wrapper cross-runtime (detecta Bun vs Node)
```

El adaptador no importa módulos privados ni clientes de servicios externos.

## Modo daemon y servicios de usuario

El daemon se ejecuta sin TUI y mantiene el runtime local MCP vivo con backoff `1s → 2s → 5s → 10s → 30s → 60s`. El `tunnel-client` se gestiona por separado mediante el servicio de usuario generado. Tras 10 fallos consecutivos el daemon entra en modo degradado y reintenta cada 5 minutos.

Socket IPC:

- **macOS**: `~/Library/Caches/desktop-remote/daemon.sock`
- **Linux/Debian**: `$XDG_RUNTIME_DIR/desktop-remote.sock`, con fallback a `~/.cache/desktop-remote/desktop-remote.sock`

En macOS se instala `~/Library/LaunchAgents/com.desktop-remote.daemon.plist` con `RunAtLoad`, `KeepAlive` y throttling. En Debian/Linux se instala una unidad en `~/.config/systemd/user/desktop-remote.service` y se gestiona con `systemctl --user`.

No se depende del `PATH` interactivo del shell: la instalación guarda rutas absolutas en una ubicación estable del usuario.

Para desarrollo existe `desktop-remote daemon`, pero en producción se recomienda usar `desktop-remote install/start/stop/restart`.

## Estado de compatibilidad

- macOS: `launchd` de usuario + Bun para la TUI.
- Debian/Linux: `systemd --user`; daemon y comandos administrativos compatibles con Node.js o Bun.
- TUI OpenTUI: requiere Bun actualmente.
- Pipe mode y `replay` se conservan como herramientas de compatibilidad/diagnóstico; el túnel usa `tunnel-client` y es opcional.

## Gates de estabilidad

```bash
bun test
bun run typecheck
bun run build:prod
bun run test:soak
bun run test:soak:real
```

`test:soak` procesa 1,000,000 de eventos simulados y 1,000 ciclos de attach/detach verificando límites de memoria, FDs y archivos. `test:soak:real` dura 30 minutos por defecto y ejercita timers, sockets y reconexiones reales.

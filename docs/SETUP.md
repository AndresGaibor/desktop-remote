# Desktop Remote — Guía de Instalación y Uso

## Persistencia tras Reinicio

Ambos LaunchAgents están configurados con `RunAtLoad=true` y `KeepAlive=true`:

```
~/Library/LaunchAgents/com.desktop-remote.daemon.plist
~/Library/LaunchAgents/com.desktop-remote.tunnel.plist
```

Al reiniciar el Mac, el sistema los arranca automáticamente. No se requiere acción manual.

---

## Requisitos Previos

- macOS (este documento)
- [Bun](https://bun.sh) instalado
- Cuenta de OpenAI con acceso a OpenAI Platform
- Acceso a https://platform.openai.com/settings/organization/tunnels

---

## Paso 1 — Obtener la API Key de Control Plane

La key del plano de control se guarda en un archivo local fuera del repo:

```
~/.config/desktop-remote/control-plane-api-key
```

### Opción A: Ya existe (máquina actual)

```bash
cat ~/.config/desktop-remote/control-plane-api-key
```

No necesitas copiar el valor a ChatGPT. El perfil de `tunnel-client` debe referenciar este archivo mediante `file:/ruta/...`.

### Opción B: Crear una nueva key

1. Ve a https://platform.openai.com/settings/organization/api-keys
2. Click "Create new key"
3. Nombre: `desktop-remote-tunnel` (o el que prefieras)
4. Copia la key generada
5. Créala como archivo:

```bash
mkdir -p ~/.config/desktop-remote
echo -n "sk-..." > ~/.config/desktop-remote/control-plane-api-key
chmod 600 ~/.config/desktop-remote/control-plane-api-key
```

> **Importante:** el archivo debe tener modo `0600`. El túnel lo rechazará si es legible por otros usuarios.

---

## Paso 2 — Obtener el Tunnel ID

1. Ve a https://platform.openai.com/settings/organization/tunnels
2. Click "Create tunnel"
3. Selecciona "Local MCP server"
4. Copia el **Tunnel ID** (formato: `tunnel_xxxxxxxx`)

---

## Paso 3 — Conectar el túnel desde ChatGPT

1. Abre https://chatgpt.com/plugins.
2. Asegúrate de tener **Developer mode** habilitado en Settings → Security and login.
3. Pulsa `+` para crear una app de developer mode.
4. Escribe el nombre y la descripción visibles para el usuario.
5. En **Connection**, selecciona **Tunnel**.
6. Selecciona el túnel disponible o pega su `tunnel_id`.
7. Crea la conexión y revisa las 24 tools descubiertas.

ChatGPT no ejecuta directamente `/Users/.../desktop-remote-mcp`: el comando local pertenece al perfil de `tunnel-client`. ChatGPT se conecta al endpoint de túnel alojado por OpenAI y `tunnel-client` reenvía las llamadas al MCP local por `stdio`.

### Verificar desde ChatGPT

Después de cualquier cambio de nombres, descriptions, schemas o annotations:

1. Abre la conexión en https://chatgpt.com/plugins.
2. Pulsa **Refresh**.
3. Confirma que la metadata descubierta cambió.
4. Abre una conversación **nueva**, añade `Remote Desktop Mac` desde Tools y prueba una operación read-only.

Por ejemplo:

```
Lista los procesos en ejecución
```

Deberías ver las 24 tools disponibles sin error de schema.

---

## Paso 4 — Instalación en Mac (nueva máquina o re-instalación)

### 4.1 Clonar el repo

```bash
git clone https://github.com/tu-usuario/desktop-remote.git
cd desktop-remote
```

### 4.2 Instalar dependencias

```bash
bun install
```

### 4.3 Construir binarios de producción

```bash
bun run build:prod
```

Esto genera `dist/desktop-remote` (layout `single` con CLI + daemon en un binario).

### 4.4 Instalar los servicios

```bash
bun run bin/cli.ts install
```

Esto:
- Copia `dist/desktop-remote` a `~/Library/Application Support/desktop-remote/bin/`
- Crea el LaunchAgent del daemon
- Instala y habilita el servicio `desktop-remote.daemon`. El servicio de `tunnel-client` se genera por separado en el paso 4.5.

### 4.5 Configurar el túnel

Genera primero el perfil con el `tunnel-client` oficial y su sample de MCP local por `stdio`:

```bash
TUNNEL_ID="tunnel_xxxxxxxx"
PROFILE_DIR="$HOME/Library/Application Support/desktop-remote"
MCP_COMMAND="$HOME/.local/bin/desktop-remote-mcp"
KEY_FILE="$HOME/.config/desktop-remote/control-plane-api-key"

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile tunnel \
  --profile-dir "$PROFILE_DIR" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-command "$MCP_COMMAND" \
  --control-plane-api-key-ref "file:$KEY_FILE" \
  --health-listen-addr 127.0.0.1:0 \
  --force
```

Después usa Desktop Remote para validar ese perfil y generar el LaunchAgent del túnel:

```bash
desktop-remote tunnel init \
  --tunnel-id "$TUNNEL_ID" \
  --profile "$PROFILE_DIR/tunnel.yaml"

# Validación local del perfil guardado
desktop-remote tunnel doctor

# Validación autoritativa del tunnel-client
tunnel-client doctor --profile-file "$PROFILE_DIR/tunnel.yaml" --explain
```

Las referencias `env:VARIABLE` y `file:/ruta` son válidas. No guardes una API key literal dentro de `tunnel.yaml`.

### 4.6 Iniciar los servicios manualmente (sin reiniciar)

```bash
# Opción A: usando launchctl
launchctl kickstart -k gui/$(id -u)/com.desktop-remote.daemon
launchctl kickstart -k gui/$(id -u)/com.desktop-remote.tunnel

# Espera ~5 segundos, luego verifica el puerto efímero elegido
HEALTH_URL_FILE="$HOME/Library/Application Support/desktop-remote/tunnel-health.url"
BASE_URL="$(cat "$HEALTH_URL_FILE")"
curl -fsS "$BASE_URL/readyz"

# Opción B: verificar con el doctor
tunnel-client doctor --profile-file ~/Library/Application\ Support/desktop-remote/tunnel.yaml --explain
```

---

## Paso 5 — Verificación del Sistema

```bash
# 1. Servicios activos
launchctl print gui/$(id -u)/com.desktop-remote.daemon | grep 'state ='
launchctl print gui/$(id -u)/com.desktop-remote.tunnel | grep 'state ='

# 2. Procesos
ps aux | grep '[d]esktop-remote\|[t]unnel-client'

# 3. Salud/readiness del Secure MCP Tunnel
HEALTH_URL_FILE="$HOME/Library/Application Support/desktop-remote/tunnel-health.url"
BASE_URL="$(cat "$HEALTH_URL_FILE")"
curl -fsS "$BASE_URL/healthz"
curl -fsS "$BASE_URL/readyz"

# 4. Doctor del túnel
tunnel-client doctor \
  --profile-file ~/Library/Application\ Support/desktop-remote/tunnel.yaml \
  --explain
```

Esperado: ambos `state = running`, doctor con `RESULT ok`.

---

## Uso desde ChatGPT

### Iniciar un proceso

```
Inicia un proceso que ejecute "pwd" y muestra la salida
```

### Listar archivos

```
Lista los archivos en /tmp con profundidad 2
```

### Buscar en archivos

```
Busca la palabra "function" en los archivos .ts de ~/proyectos
```

### Matar un proceso

```
Mata el proceso con PID 12345
```

---

## Estructura de Archivos

```
~/Library/Application Support/desktop-remote/
├── bin/
│   └── desktop-remote          # Binario de producción
├── tunnel.yaml                 # Perfil del túnel
├── config.json                 # Configuración local (creado al primer uso)
└── logs/
    └── daemon.log              # Logs del daemon

~/.config/desktop-remote/
└── control-plane-api-key       # API key del plano de control (modo 0600)

~/.local/bin/
└── desktop-remote-mcp          # Wrapper sin espacios para el túnel

~/Library/LaunchAgents/
├── com.desktop-remote.daemon.plist
└── com.desktop-remote.tunnel.plist
```

---

## Solución de Problemas

### `FORBIDDEN: This conversation does not support developer MCPs` o el MCP desaparece de un chat

- Verifica que Developer mode esté habilitado en Settings → Security and login.
- Abre la conexión en https://chatgpt.com/plugins y pulsa **Refresh**.
- Confirma que `Remote Desktop Mac` siga habilitado.
- Usa una conversación **nueva** y vuelve a añadir la conexión desde Tools.
- Si `tunnel-client` está `ready`, no reinicies servicios solo porque un chat antiguo haya perdido el MCP.
- Sigue `docs/CHATGPT_MCP_RUNBOOK.md` para distinguir un fallo de ChatGPT de uno del Mac.

### El túnel no conecta

```bash
tunnel-client doctor \
  --profile-file ~/Library/Application\ Support/desktop-remote/tunnel.yaml \
  --explain
```

Revisa especialmente:
- `CHECK control_plane_api_key` — PASS
- `CHECK tunnel_id` — PASS
- `CHECK mcp_target` — PASS

### El daemon no responde

```bash
# Ver logs
tail -f ~/Library/Application\ Support/desktop-remote/logs/daemon.log

# Reiniciar manualmente
launchctl kickstart -k gui/$(id -u)/com.desktop-remote.daemon
```

### Las tools no aceptan argumentos

Esto ya está corregido — todas las 24 tools tienen schemas Zod. Si ocurre, verifica que el túnel esté usando el binario actualizado:

```bash
ps aux | grep '[d]esktop-remote mcp'
# Debe mostrar el wrapper en ~/.local/bin/
```

### Reiniciar desde cero

```bash
# Desinstalar servicios
launchctl bootout gui/$(id -u)/com.desktop-remote.daemon
launchctl bootout gui/$(id -u)/com.desktop-remote.tunnel

# Re-instalar
bun run bin/cli.ts install

# Reiniciar
launchctl kickstart -k gui/$(id -u)/com.desktop-remote.daemon
launchctl kickstart -k gui/$(id -u)/com.desktop-remote.tunnel
```

---

## Arquitectura

```
┌──────────────────────────────────────────────────┐
│  ChatGPT (cliente MCP via tunnel.openai.com)     │
└──────────────────────┬───────────────────────────┘
                       │ stdio MCP tunnel
                       ▼
┌──────────────────────────────────────────────────┐
│  tunnel-client (LaunchAgent, Mac)                 │
│  /opt/homebrew/bin/tunnel-client run \           │
│    --profile-file .../tunnel.yaml                │
└──────────────────────┬───────────────────────────┘
                       │ stdio
                       ▼
┌──────────────────────────────────────────────────┐
│  desktop-remote-mcp (wrapper, ~/.local/bin/)     │
│  → /path/to/bin/desktop-remote mcp "$@"          │
└──────────────────────┬───────────────────────────┘
                       │ Unix socket IPC
                       ▼
┌──────────────────────────────────────────────────┐
│  desktop-remote daemon (LaunchAgent, Mac)        │
│  ~/Library/Application Support/desktop-remote/   │
│  bin/desktop-remote daemon                       │
└──────────────────────┬───────────────────────────┘
                       │ OperationIpcClient
                       ▼
┌──────────────────────────────────────────────────┐
│  DesktopOperationExecutor (24 tools locales)     │
│  Bun.serve() stdio transport                    │
└──────────────────────────────────────────────────┘
```

El daemon ejecuta operaciones localmente en el Mac: sistema de archivos, procesos, búsqueda y configuración.

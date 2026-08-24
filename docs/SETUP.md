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

Copia el valor — lo necesitarás en el Paso 3.

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

## Paso 3 — Configurar ChatGPT como Cliente MCP

1. Abre https://chatgpt.com
2. Ve a Settings → Beta → Developer MCP Settings (o Settings → Connectors según la versión)
3. Añade un conector nuevo:
   - **Nombre:** `Remote Desktop Mac` (o el que prefieras)
   - **Command:** `/Users/andresgaibor/.local/bin/desktop-remote-mcp` (ajusta la ruta si tu usuario es diferente)
   - **Env:** `PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`
4. Guarda

### Verificar desde ChatGPT

En una conversación nueva con el conector habilitado, prueba:

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
- Habilita ambos servicios con `RunAtLoad` y `KeepAlive`

### 4.5 Configurar el túnel

```bash
tunnel-client tunnel init \
  --tunnel-id tunnel_xxxxxxxx \
  --profile-file ~/Library/Application\ Support/desktop-remote/tunnel.yaml
```

Luego edita `tunnel.yaml` manualmente para apuntar a la API key:

```yaml
control_plane:
  api_key: file:/Users/TU_USUARIO/.config/desktop-remote/control-plane-api-key
```

### 4.6 Iniciar los servicios manualmente (sin reiniciar)

```bash
# Opción A: usando launchctl
launchctl kickstart -k gui/$(id -u)/com.desktop-remote.daemon
launchctl kickstart -k gui/$(id -u)/com.desktop-remote.tunnel

# Espera ~5 segundos, luego verifica
curl -fsS http://127.0.0.1:61630/readyz

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

# 3. Salud del daemon
curl -fsS http://127.0.0.1:61630/readyz

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

### `FORBIDDEN: This conversation does not support developer MCPs`

- Usa una conversación **nueva** en ChatGPT.
- Verifica que Developer MCPs / Connectors esté habilitado en Settings.
- El conector `Remote Desktop Mac` debe aparecer como habilitado.

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

# Runbook — ChatGPT + Desktop Remote MCP

Usa este orden cuando `@Remote Desktop Mac` desaparece, queda deshabilitado o falla durante una llamada. El objetivo es localizar la capa que falló **antes de reiniciar nada** y conservar evidencia suficiente para distinguir daemon, MCP stdio, túnel y control plane.

## 1. Comprobar el daemon local

```bash
desktop-remote status
launchctl print gui/$(id -u)/com.desktop-remote.daemon | grep 'state ='
```

Esperado: `state: online` y LaunchAgent `running`.

## 2. Comprobar el Secure MCP Tunnel

```bash
launchctl print gui/$(id -u)/com.desktop-remote.tunnel | grep 'state ='
tunnel-client --version
tunnel-client doctor \
  --profile-file "$HOME/Library/Application Support/desktop-remote/tunnel.yaml" \
  --explain
```

Esperado: LaunchAgent `running` y `RESULT ok`. Para un target `stdio`, los checks de red MCP/OAuth pueden aparecer como `SKIP`; eso es normal.

Si la versión instalada no es la versión estable actual de `tunnel-client`, actualízala antes de concluir que el problema está en Desktop Remote. Conserva primero los logs de la incidencia.

## 3. Comprobar liveness y readiness reales

Usa primero el diagnóstico integrado:

```bash
desktop-remote tunnel status
```

Estados esperados:

- `ready`: `/healthz` y `/readyz` responden correctamente.
- `not_ready`: el proceso está vivo pero readiness falla.
- `unreachable`: el endpoint local no responde.
- `not_configured`: falta `tunnel-health.url`.
- `invalid`: el archivo contiene una URL que no es HTTP loopback válida.

La instalación escribe el puerto efímero elegido por `tunnel-client` en:

```bash
HEALTH_URL_FILE="$HOME/Library/Application Support/desktop-remote/tunnel-health.url"
BASE_URL="$(cat "$HEALTH_URL_FILE")"
curl -fsS "$BASE_URL/healthz"
curl -fsS "$BASE_URL/readyz"
```

Esperado: `live` y `ready`. No asumas un puerto fijo: el servicio usa `127.0.0.1:0` para evitar colisiones.

En una instalación antigua sin `tunnel-health.url`, localiza temporalmente el listener con:

```bash
PID="$(pgrep -f 'tunnel-client run.*desktop-remote/tunnel.yaml' | head -1)"
lsof -Pan -p "$PID" -iTCP -sTCP:LISTEN
```

## 4. Comprobar el proceso MCP stdio

```bash
ps -axo pid,ppid,etime,command | grep '[d]esktop-remote mcp'
```

El proceso MCP debe ser hijo del `tunnel-client`. El MCP abre una conexión IPC nueva al daemon para cada operación, por lo que un reinicio del daemon por sí solo no debería dejar una conexión IPC persistente obsoleta.

Si el túnel está `ready`, no reinicies el daemon solo porque una conversación de ChatGPT haya perdido el conector.

## 5. Revisar logs antes de reiniciar

En macOS:

```bash
LOG_DIR="$HOME/Library/Application Support/desktop-remote/logs"
tail -150 "$LOG_DIR/daemon.log"
tail -150 "$LOG_DIR/mcp.log"
tail -150 "$LOG_DIR/tunnel.stdout.log"
tail -150 "$LOG_DIR/tunnel.stderr.log"
```

Los logs cumplen funciones distintas:

- `daemon.log`: ciclo de vida y fallos del daemon local.
- `mcp.log`: arranque y conexión del servidor MCP stdio, sin payloads de tools.
- `tunnel.stdout.log` / `tunnel.stderr.log`: salida persistente de `tunnel-client` y del target stdio heredada por el servicio.

No registres argumentos de tools, credenciales ni payloads MCP completos. Los logs estructurados propios de Desktop Remote pasan por redacción y rotación.

## 6. Recuperación controlada

Después de recopilar estado y logs, si el túnel está vivo pero no recupera readiness o el transporte stdio quedó degradado, reinicia **solo el servicio del túnel** primero:

```bash
launchctl kickstart -k gui/$(id -u)/com.desktop-remote.tunnel
```

Luego comprueba:

```bash
desktop-remote tunnel status
ps -axo pid,ppid,etime,command | grep -E '[t]unnel-client|[d]esktop-remote mcp'
```

Si se modificó el plist del LaunchAgent, `kickstart` no relee su definición. En ese caso haz `bootout` + `bootstrap` con el plist actualizado y vuelve a verificar readiness.

## 7. Si la infraestructura está sana pero ChatGPT no muestra el MCP

1. Abre Settings → Connectors/Plugins y busca `Remote Desktop Mac`.
2. Usa **Refresh** para volver a escanear tools y metadata.
3. Confirma que el conector siga habilitado.
4. Abre una **conversación nueva** y selecciona `@Remote Desktop Mac`.
5. Prueba primero una operación read-only como `get_config` o `list_directory`.

Una conversación que perdió el MCP puede conservar ese estado aunque el supervisor local haya recuperado el proceso. No uses la presencia del conector en un chat antiguo como health check del Mac.

## 8. Qué recopilar si vuelve a fallar

```bash
date -u '+%Y-%m-%dT%H:%M:%SZ'
desktop-remote status
desktop-remote tunnel status
tunnel-client --version
ps -axo pid,ppid,lstart,etime,command | grep -E '[t]unnel-client|[d]esktop-remote (daemon|mcp)'
LOG_DIR="$HOME/Library/Application Support/desktop-remote/logs"
tail -150 "$LOG_DIR/daemon.log"
tail -150 "$LOG_DIR/mcp.log"
tail -150 "$LOG_DIR/tunnel.stdout.log"
tail -150 "$LOG_DIR/tunnel.stderr.log"
```

Guarda también la hora exacta de la llamada fallida. Eso permite correlacionar ChatGPT, control plane, `tunnel-client`, MCP stdio, IPC y daemon sin confundir recuperaciones de componentes diferentes.

## Interpretación rápida

- `daemon offline` → problema local de Desktop Remote.
- `doctor` falla → perfil, credencial, permisos de túnel o target MCP.
- `/healthz` falla → `tunnel-client` no está atendiendo su health endpoint.
- `/healthz` funciona pero `/readyz` falla → el proceso vive, pero una dependencia de readiness no está lista.
- tools devuelven un resultado MCP con `isError` → la llamada llegó al handler MCP y falló una operación/IPC normal.
- el conector devuelve HTTP 502 antes de un resultado MCP → investiga el límite control plane ↔ túnel ↔ transporte MCP stdio.
- todo lo anterior funciona y solo un chat falla → refresca el conector y usa una conversación nueva antes de reiniciar servicios.

## Seguridad de secretos en procesos

No pases API keys, tokens, passwords ni headers Authorization como argumentos del comando MCP. Los argumentos de proceso son observables por herramientas del sistema como `ps`.

Preferencias:

1. Variable de entorno específica del servidor MCP.
2. Referencia `file:/ruta` cuando el runtime la soporte.
3. Nunca `--api-key <valor>` o equivalentes.

`desktop-remote tunnel doctor` rechaza perfiles cuyo comando MCP contiene flags de credenciales, `list_processes` redacta defensivamente secretos si otro proceso del sistema fue iniciado de forma insegura y los logs propios redactan valores con forma de API key.

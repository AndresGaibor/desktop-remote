# Runbook — ChatGPT + Desktop Remote MCP

Usa este orden cuando `@Remote Desktop Mac` desaparece, queda deshabilitado o falla durante una llamada. El objetivo es localizar la capa que falló antes de reiniciar nada.

## 1. Comprobar el daemon local

```bash
desktop-remote status
launchctl print gui/$(id -u)/com.desktop-remote.daemon | grep 'state ='
```

Esperado: `state: online` y LaunchAgent `running`.

## 2. Comprobar el Secure MCP Tunnel

```bash
launchctl print gui/$(id -u)/com.desktop-remote.tunnel | grep 'state ='
tunnel-client doctor \
  --profile-file "$HOME/Library/Application Support/desktop-remote/tunnel.yaml" \
  --explain
```

Esperado: LaunchAgent `running` y `RESULT ok`. Para un target `stdio`, los checks de red MCP/OAuth pueden aparecer como `SKIP`; eso es normal.
## 3. Comprobar liveness y readiness reales

Las instalaciones nuevas escriben el puerto efímero elegido por `tunnel-client` en:

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
ps aux | grep '[d]esktop-remote-mcp'
```

El proceso debe ser hijo del `tunnel-client`. Si el túnel está `ready`, no reinicies el daemon solo porque una conversación de ChatGPT haya perdido el conector.
## 5. Si la infraestructura está sana pero ChatGPT no muestra el MCP

1. Abre Settings → Connectors/Plugins y busca `Remote Desktop Mac`.
2. Usa **Refresh** para volver a escanear tools y metadata.
3. Confirma que el conector siga habilitado.
4. Abre una **conversación nueva** y selecciona `@Remote Desktop Mac`.
5. Prueba primero una operación read-only como `get_config` o `list_directory`.

Una conversación que perdió el MCP puede conservar ese estado aunque el supervisor local haya recuperado el proceso. No uses la presencia del conector en un chat antiguo como health check del Mac.

## 6. Qué recopilar si vuelve a fallar

```bash
desktop-remote status
desktop-remote logs | tail -150
tunnel-client doctor \
  --profile-file "$HOME/Library/Application Support/desktop-remote/tunnel.yaml" \
  --explain
```

Además guarda la hora exacta de la llamada fallida. Eso permite correlacionar ChatGPT, control plane, `tunnel-client`, MCP stdio, IPC y daemon sin confundir recuperaciones de componentes diferentes.

## Interpretación rápida

- `daemon offline` → problema local de Desktop Remote.
- `doctor` falla → perfil, credencial, permisos de túnel o target MCP.
- `/healthz` falla → `tunnel-client` no está vivo.
- `/healthz` funciona pero `/readyz` falla → el proceso vive, pero una dependencia de readiness no está lista.
- todo lo anterior funciona y solo un chat falla → refresca el conector y usa una conversación nueva antes de reiniciar servicios.
## Seguridad de secretos en procesos

No pases API keys, tokens, passwords ni headers Authorization como argumentos del comando MCP. Los argumentos de proceso son observables por herramientas del sistema como `ps`.

Preferencias:

1. Variable de entorno específica del servidor MCP.
2. Referencia `file:/ruta` cuando el runtime la soporte.
3. Nunca `--api-key <valor>` o equivalentes.

`desktop-remote tunnel doctor` rechaza perfiles cuyo comando MCP contiene flags de credenciales, y `list_processes` redacta defensivamente secretos si otro proceso del sistema fue iniciado de forma insegura.

# Referencias oficiales de OpenAI para MCP

Snapshot descargado el 2026-08-24 para mantener junto al código las reglas que afectan a Desktop Remote.

Estas copias son material de referencia; la fuente canónica sigue siendo `developers.openai.com`. Antes de cambios importantes de protocolo, seguridad o despliegue, vuelve a consultar la documentación en línea.

## Archivos incluidos

- `secure-mcp-tunnels.md` — https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- `mcp-server-concepts.md` — https://developers.openai.com/plugins/concepts/mcp-server
- `build-mcp-server.md` — https://developers.openai.com/plugins/build/mcp-server
- `connect-chatgpt.md` — https://developers.openai.com/plugins/deploy/connect-chatgpt
- `optimize-metadata.md` — https://developers.openai.com/plugins/guides/optimize-metadata
- `troubleshooting.md` — https://developers.openai.com/plugins/deploy/troubleshooting

## Conclusiones para Desktop Remote

1. Secure MCP Tunnel soporta un servidor MCP local por `stdio`; no es necesario convertir Desktop Remote a HTTP.
2. `tunnel-client` debe permanecer ejecutándose para discovery y para cada llamada MCP desde ChatGPT.
3. Las referencias de credenciales del túnel pueden usar `env:VARIABLE` o `file:/ruta`; una clave literal no debe guardarse en el perfil.
4. La comprobación autoritativa del perfil es `tunnel-client doctor --profile-file ... --explain` y la disponibilidad real se confirma con `/readyz`.
5. Las tools deben publicar título, descripción orientada al uso, input schema, output schema cuando devuelven datos estructurados y annotations de seguridad correctas.
6. `instructions` debe contener solo reglas compartidas entre tools y poner lo esencial al principio.
7. Después de cambiar tools, schemas o metadata, refresca el conector en ChatGPT y prueba desde una conversación nueva.

## Dos conceptos distintos llamados “plugin”

- La app developer-mode de **ChatGPT** (`Remote Desktop Mac`) descubre las tools del MCP a través del túnel. Esa es la integración que debe refrescarse en `chatgpt.com/plugins` cuando cambia la metadata.
- `tunnel-client codex plugin install` instala un router local opcional para **Codex** sobre los comandos `tunnel-client runtimes` y `admin-profiles`. No es requisito del conector de ChatGPT.

Por eso `CHECK codex_plugin SKIP` en `tunnel-client doctor --explain` no representa un fallo de Desktop Remote en ChatGPT.
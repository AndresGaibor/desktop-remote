# Desktop Remote CLI Formatter 🚀

Una herramienta CLI elegante y moderna para formatear y hacer legibles las salidas del agente MCP `@wonderwhy-er/desktop-commander`.

## 🛠️ Uso

### 1. Instalación
```bash
bun install
```

### 2. Ejecución directa (Usa desktop-commander instalado localmente)
```bash
bun run start
```
o pasando argumentos personalizados:
```bash
bun run bin/cli.ts remote --persist-session
```

### 3. Uso con `bun link` (Comando global `desktop-remote`)
```bash
bun link
desktop-remote remote --persist-session
```

### 4. Tuberías (Pipe desde stdin)
También puedes pasar la salida de cualquier comando existente:
```bash
desktop-commander remote --persist-session | desktop-remote
```

## ✨ Características
- 🔐 **Visualización destacada de autenticación**: Cuadro interactivo claro con la URL y el código de verificación de 8 caracteres.
- ⚡ **Desglose de llamadas a herramientas (`start_process`, `read_file`, etc.)**: Muestra los pasos exactos, archivos creados y previsualización de código con resaltado de sintaxis.
- 🧪 **Formateador de resultados de pruebas**: Resalta automáticamente pruebas `bun test` o `jest` pasadas (`✔ PASS`) y falladas (`✖ FAIL`).
- 📊 **Git Status limpio**: Muestra archivos modificados, agregados o eliminados con colores (`M`, `A`, `D`).
- 🧹 **Eliminación de ruido**: Oculta stack traces de node/bun y logs excesivos de depuración a menos que uses `--verbose`.

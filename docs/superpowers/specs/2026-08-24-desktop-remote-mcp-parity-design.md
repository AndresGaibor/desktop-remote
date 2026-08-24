# Desktop Remote MCP — Paridad con Desktop Commander

## 1. Visión y Propósito

Reemplazar `desktop-commander-runtime` y `@wonderwhy-er/desktop-commander` por un MCP local propio que exponga las mismas 24 tools del cliente Desktop Commander con schemas Zod tipados y ejecución local completa. El túnel ya existe; esta tarea solo cubre el catálogo, los schemas de transporte y la implementación pendiente.

**Objetivo:** Un cliente MCP (ChatGPT, Codex, etc.) puede listar tools con argumentos correctos y ejecutarlas sin `FORBIDDEN` ni `Operation is not implemented`.

## 2. Alcance

### 2.1 Incluido

- 24 tools públicas del cliente Desktop Commander con schemas Zod completos y `inputSchema` MCP correcto
- Executor local para las 24 tools (sin `give_feedback_to_desktop_commander` ni `get_prompts`)
- Parámetros de search alineados con la referencia (`path`, `pattern`, `searchType`)
- `write_file` con modo `append`
- `read_file` con soporte para URLs (usando fetch)
- Tests TDD para toda lógica de executor nueva
- Verificación de integración: `bun test`, `bun run typecheck`, `bun run build:prod`

### 2.2 Excluido

- `give_feedback_to_desktop_commander` — vincula al proveedor original
- `get_prompts` — mecanismo interno no publicado
- `track_ui_event` — analytics interno
- Desktop Commander App / instalador oficial

## 3. Arquitectura

```
┌─────────────────────────────────────────────────┐
│              MCP stdio transport                │
│  Bun.serve() + StdioServerTransport            │
│  /bin/mcp.ts entrada                           │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│   src/mcp/server.ts                             │
│   createMcpServer(executor)                     │
│   registerTool(name, { description, inputSchema })│
│   inputSchema = zodSchemaToMcpSchema(ZOD_SCHEMA) │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│   src/mcp/tools.ts                              │
│   TOOL_SCHEMAS: Record<ToolName, ZodSchema>    │
│   createToolDefinitions() → McpToolDefinition[] │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│   src/core/executor.ts                          │
│   DesktopOperationExecutor                      │
│   26 handlers dispatch a operations.ts          │
└─────────────────────────────────────────────────┘
```

## 4. Catálogo de Tools y Schemas

### 4.1 Configuración

#### `get_config`
```typescript
z.object({ origin: z.enum(["ui", "llm"]).optional() })
```
Retorna configuración completa del servidor. Sin argumentos requeridos.

#### `set_config_value`
```typescript
z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.string().array(), z.null()]),
  origin: z.enum(["ui", "llm"]).optional(),
})
```

### 4.2 Procesos

#### `start_process`
```typescript
z.object({
  command: z.string().min(1),        // cadena única, no array
  timeout_ms: z.number().int().positive().default(30000),
  shell: z.string().optional(),
  verbose_timing: z.boolean().optional(),
})
```
> La referencia usa `command: string` (no array). El IPC deldaemon original usa array. Se mantiene el IPC como array y se convierte en el handler del executor.

#### `read_process_output`
```typescript
z.object({
  pid: z.number().int().positive(),
  timeout_ms: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().positive().optional(),
  verbose_timing: z.boolean().optional(),
})
```

#### `interact_with_process`
```typescript
z.object({
  pid: z.number().int().positive(),
  input: z.string(),
  timeout_ms: z.number().int().positive().optional(),
  wait_for_prompt: z.boolean().optional(),
  verbose_timing: z.boolean().optional(),
})
```

#### `force_terminate`
```typescript
z.object({ pid: z.number().int().positive() })
```

#### `list_sessions`
```typescript
z.object({})
```
Sin argumentos.

#### `list_processes`
```typescript
z.object({})
```
Sin argumentos. Retorna array de procesos del sistema.

#### `kill_process`
```typescript
z.object({ pid: z.number().int().positive() })
```

### 4.3 Sistema de Ficheros

#### `read_file`
```typescript
z.object({
  path: z.string().min(1),
  isUrl: z.boolean().optional().default(false),
  offset: z.number().int().nonnegative().optional().default(0),
  length: z.number().int().positive().optional().default(1000),
  sheet: z.string().optional(),
  range: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  origin: z.enum(["ui", "llm"]).optional(),
})
```

#### `read_multiple_files`
```typescript
z.object({ paths: z.array(z.string().min(1)).min(1) })
```

#### `write_file`
```typescript
z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(["rewrite", "append"]).optional().default("rewrite"),
  origin: z.enum(["ui", "llm"]).optional(),
})
```

#### `write_pdf`
```typescript
z.object({
  path: z.string().min(1),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  outputPath: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
})
```

#### `create_directory`
```typescript
z.object({ path: z.string().min(1) })
```

#### `list_directory`
```typescript
z.object({
  path: z.string().min(1),
  depth: z.number().int().nonnegative().optional().default(2),
  origin: z.enum(["ui", "llm"]).optional(),
})
```

#### `move_file`
```typescript
z.object({
  source: z.string().min(1),
  destination: z.string().min(1),
})
```

#### `get_file_info`
```typescript
z.object({ path: z.string().min(1) })
```

#### `edit_block`
```typescript
z.object({
  file_path: z.string().min(1),
  old_string: z.string().optional(),
  new_string: z.string().optional(),
  range: z.object({ start: z.number().int(), end: z.number().int() }).optional(),
  content: z.string().optional(),
  expected_replacements: z.number().int().positive().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  origin: z.enum(["ui", "llm"]).optional(),
})
```
> Uno de `old_string + new_string` o `range + content` es requerido.

### 4.4 Búsqueda

#### `start_search`
```typescript
z.object({
  path: z.string().min(1),
  pattern: z.string().min(1),
  searchType: z.enum(["files", "content"]).optional().default("files"),
  filePattern: z.string().optional(),
  ignoreCase: z.boolean().optional().default(true),
  maxResults: z.number().int().positive().optional(),
  includeHidden: z.boolean().optional().default(false),
  contextLines: z.number().int().nonnegative().optional().default(5),
  timeout_ms: z.number().int().positive().optional(),
  earlyTermination: z.boolean().optional(),
  literalSearch: z.boolean().optional().default(false),
  origin: z.enum(["ui", "llm"]).optional(),
})
```
> Parámetros renombrados respecto a la implementación actual (`root` → `path`, `mode` → `searchType`).

#### `get_more_search_results`
```typescript
z.object({
  sessionId: z.string().min(1),
  offset: z.number().int().nonnegative().optional().default(0),
  length: z.number().int().positive().optional().default(100),
})
```

#### `stop_search`
```typescript
z.object({ sessionId: z.string().min(1) })
```

#### `list_searches`
```typescript
z.object({})
```

### 4.5 Analíticas

#### `get_usage_stats`
```typescript
z.object({})
```

#### `get_recent_tool_calls`
```typescript
z.object({
  maxResults: z.number().int().min(1).max(1000).optional().default(50),
  toolName: z.string().optional(),
  since: z.string().datetime().optional(),
})
```

## 5. Operaciones Pendientes de Implementación

| Tool | Prioridad | Dependencias |
|---|---|---|
| `read_multiple_files` | Alta | Sin dependencia nueva |
| `interact_with_process` | Alta | `ProcessManager.interact()` |
| `force_terminate` | Alta | `ProcessManager.terminate()` |
| `list_sessions` | Media | `ProcessManager.listSessions()` |
| `list_processes` | Media | `ps` spawning |
| `kill_process` | Media | `ProcessManager.kill()` |
| `get_config` | Baja | Store de config local |
| `set_config_value` | Baja | Store de config local |
| `get_usage_stats` | Baja | Counter de llamadas |
| `get_recent_tool_calls` | Baja | Historial de llamadas |
| `write_pdf` | Alta | Ya existe, falta registrar |
| URL fetch en `read_file` | Media | `fetch` + streams |

## 6. Estrategia de Implementación

### Fase 1 — Schemas MCP (sin cambio de comportamiento)
1. Crear `src/mcp/schemas.ts` con todos los Zod schemas
2. Modificar `src/mcp/tools.ts` para usar `TOOL_SCHEMAS`
3. Modificar `src/mcp/server.ts` para usar `inputSchema` derivado
4. Verificar que `bun test` siga verde
5. Verificar con `bun run typecheck`

### Fase 2 — Implementación de operaciones pendientes
Para cada tool pendiente, seguir ciclo TDD:
1. Escribir test en `test/core/executor.test.ts`
2. Implementar en `src/core/executor.ts`
3. Registrar en `src/core/operations.ts` si es nueva
4. Verificar `bun test`

### Fase 3 — Búsqueda y write_file
1. Modificar `SearchManager` para параметр `path` y `searchType`
2. Modificar `write_file` para soportar `mode: "append"`
3. Modificar `read_file` para soportar `isUrl: true`

### Fase 4 — Verificación integral
1. `bun test`
2. `bun run typecheck`
3. `bun run build:prod`
4. Prueba manual del túnel MCP

## 7. Archivos Modificados

| Archivo | Cambio |
|---|---|
| `src/mcp/schemas.ts` | **Nuevo** — todos los Zod schemas |
| `src/mcp/tools.ts` | Usa `TOOL_SCHEMAS` |
| `src/mcp/server.ts` | `inputSchema` derivado de schema |
| `src/core/operations.ts` | Agregar `write_pdf` |
| `src/core/executor.ts` | 10 handlers nuevos + append mode |
| `src/process/manager.ts` | `interact`, `terminate`, `listSessions`, `kill`, `listProcesses` |
| `src/search/manager.ts` | Renombrar `root` → `path`, `mode` → `searchType` |
| `src/filesystem/files.ts` | Soporte URL via fetch |
| `src/config/store.ts` | **Nuevo** — store de config y usage stats |
| `test/core/executor.test.ts` | Tests para operations nuevas |

## 8. Criterios de Éxito

- `bun test` pasa al 100% con coverage > 80%
- `bun run typecheck` sin errores
- `bun run build:prod` genera binario sin errores
- MCP `tools/list` retorna 24 tools con `inputSchema` no vacío
- Cada tool responde correctamente cuando se le pasan argumentos válidos
- Operaciones no implementadas devuelven `Operation is not implemented` (no FORBIDDEN ni crash)

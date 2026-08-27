// Workaround para un bug de tree-shaking de bun + zod v4 en el bundle de producción.
//
// zod v4 define `export const ZodLazy = /*@__PURE__*/ core.$constructor(...)` y
// `lazy()` hace `new ZodLazy(...)`. "zod" no re-exporta ZodLazy de forma que bun la
// conserve, y al ser una constante pura referenciada solo por `lazy()`, bun la
// tree-shakea del bundle. @modelcontextprotocol/server invoca z.lazy() al definir
// sus schemas, así que cada subcomando del CLI compilado crashea con
// "new ZodLazy is not a constructor".
//
// Este módulo reconstruye ZodLazy con los internals de zod y parchea z.lazy para
// usarla. Debe evaluarse ANTES de que el MCP SDK cargue sus schemas (por eso se
// importa como primer import de default-deps.ts).
import { z } from "zod";
import { $constructor, $ZodLazy } from "zod/v4/core";

/* eslint-disable @typescript-eslint/no-explicit-any */
const PatchedZodLazy = $constructor("ZodLazy", (inst: any, def: any) => {
  $ZodLazy.init(inst, def);
  (inst as any).unwrap = () => inst._zod.def.getter();
});

const zAny = z as any;
if (typeof zAny.lazy === "function" && !Object.prototype.hasOwnProperty.call(zAny, "_lazyPatched")) {
  const patched = (getter: any) => new PatchedZodLazy({ type: "lazy", getter });
  try {
    Object.defineProperty(zAny, "lazy", { value: patched, configurable: true, writable: true });
    Object.defineProperty(zAny, "_lazyPatched", { value: true, configurable: true });
  } catch {
    // En modo fuente `z` es un namespace de módulo congelado y no se puede
    // redefinir; allí z.lazy original funciona (sin tree-shaking). El parche solo
    // es necesario en el bundle compilado, donde `z` es un objeto normal.
  }
}

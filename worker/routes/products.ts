import { Hono } from "hono";
import { productCatalog } from "@/domain/products/catalog";
import { requireEmployee } from "@worker/middleware/require-employee";
import type { WorkerEnvironment } from "@worker/types";

export const productRoutes = new Hono<WorkerEnvironment>();
productRoutes.use("/*", requireEmployee);
productRoutes.get("/", (c) => c.json({ products: productCatalog.filter((product) => product.active && product.terminalEnabled) }));

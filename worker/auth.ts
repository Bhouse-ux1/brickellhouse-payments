import type { AuthorizedEmployee, WorkerBindings } from "./types";
import { readTestAccessSession } from "./services/test-access";

export async function readAuthorizedEmployee(request: Request, env: WorkerBindings): Promise<AuthorizedEmployee | null> {
  return readTestAccessSession(request, env);
}

// Command registry of the `tawny` CLI: every method the app socket serves. The CLI client parses argv, `--help` and
// `agent-context` from the JSON schemas generated here, so docs can't drift from behaviour.
import * as z from 'zod';

/** Who is calling, from the caller's env (TAWNY_CHAT_ID / TAWNY_WORKTREE). Only picks a default target. */
export interface CliCtx {
  chatId?: string;
  worktree?: string;
}

export interface CliMethod {
  /** `group.command`, snake_case: `pr.propose_comment` is `tawny pr propose-comment` */
  name: string;
  summary: string;
  params: z.ZodObject;
  /** params that may also be given positionally, in this order: `tawny review resolve <id>` */
  args?: string[];
  /** a string param read from piped stdin (a quoted heredoc) when no flag gives it: shell metacharacters stay out of argv */
  stdin?: string;
  handler(params: Record<string, unknown>, ctx: CliCtx): unknown | Promise<unknown>;
}

export class Registry {
  private methods = new Map<string, CliMethod>();

  add<S extends z.ZodObject>(m: {
    name: string;
    summary: string;
    params: S;
    args?: (keyof z.infer<S> & string)[];
    stdin?: keyof z.infer<S> & string;
    handler(params: z.infer<S>, ctx: CliCtx): unknown | Promise<unknown>;
  }) {
    this.methods.set(m.name, m as unknown as CliMethod);
  }

  async call(name: string, params: unknown, ctx: CliCtx) {
    const m = this.methods.get(name);
    if (!m) throw new Error(`unknown method ${name}`);
    const parsed = m.params.safeParse(params ?? {});
    if (!parsed.success)
      throw new Error(parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '));
    return m.handler(parsed.data as Record<string, unknown>, ctx);
  }

  /** What the client needs to parse argv and print help. */
  schema() {
    return [...this.methods.values()]
      .filter((m) => m.name !== 'cli.schema')
      .map((m) => ({
        name: m.name,
        summary: m.summary,
        params: z.toJSONSchema(m.params, { io: 'input' }),
        ...(m.args?.length ? { args: m.args } : {}),
        ...(m.stdin ? { stdin: m.stdin } : {}),
      }));
  }
}

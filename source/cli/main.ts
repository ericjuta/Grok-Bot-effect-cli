import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { stripVTControlCharacters } from "node:util";
import { Console, Effect } from "effect";

import { runCli } from "./app.js";

const noColor = process.env.NO_COLOR !== undefined;
const stripArgs = (args: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
  args.map((arg) => typeof arg === "string" ? stripVTControlCharacters(arg) : arg);

const program = Console.consoleWith((baseConsole) => runCli(process.argv).pipe(
  Console.withConsole({
    ...baseConsole,
    // @effect/cli currently renders help and validation errors as ANSI text
    // without consulting NO_COLOR or the destination stream. Its diagnostics
    // use Effect Console; MCP, RPC, and result envelopes use dedicated direct
    // writers, so this policy cannot alter protocol framing.
    log: (...args: ReadonlyArray<unknown>) =>
      baseConsole.log(...(noColor || !process.stdout.isTTY ? stripArgs(args) : args)),
    error: (...args: ReadonlyArray<unknown>) =>
      baseConsole.error(...(noColor || !process.stderr.isTTY ? stripArgs(args) : args)),
  }),
));

program.pipe(
  Effect.provide(NodeContext.layer),
  // @effect/cli already reports parse errors on stderr. Runtime cause logging
  // would otherwise write timestamped stacks to stdout and corrupt MCP/RPC
  // framing (and could echo a malformed credential embedded in an error).
  NodeRuntime.runMain({ disableErrorReporting: true, disablePrettyLogger: true }),
);

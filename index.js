import { isAbsolute, sep } from 'node:path'

/**
 * `bash_parallel` — run several independent shell commands concurrently inside
 * one tool call.
 *
 * The harness already overlaps parallel-safe tool calls, but `bash` declares no
 * `isConcurrencySafe`, so consecutive shell calls serialize. Exploration work
 * ("list this, read those, grep for that") is independent by nature and is
 * exactly what this tool batches: one model turn, one tool call, N commands in
 * flight.
 *
 * This package deliberately imports nothing but Node builtins: a linked local
 * bundle resolves its bare specifiers from its own directory tree, not from the
 * profile, so staying dependency-free is what keeps it loadable.
 *
 * @module @local/dsh-tool-bash-parallel
 */

const name = 'tool-bash-parallel'
const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv', 'workingDirectory']

const TOOL_NAME = 'bash_parallel'

/** Stable contract strings owned by the harness render layer. */
const SANDBOX_DENIAL = (mode) => `[sandbox: file access denied under ${mode} mode]`

const DEFAULTS = {
  maxCommands: 16,
  maxConcurrency: 10,
  timeoutMs: 600000
}

const DESCRIPTION = `Run 2-${DEFAULTS.maxCommands} independent shell commands concurrently (\`bash -c\` each) in one call and return every command's stdout, stderr, and exit code. Commands cannot see each other: no shared working directory, environment, or output. Use it while exploring a project — list several directories, read several files, run independent rg/find/git queries — instead of issuing several bash calls in a row. Keep commands that depend on each other's output in separate steps. Each command runs in a fresh shell, so pass \`workdir\` rather than using \`cd\`. Output over the per-command cap is truncated. Check the [exit code: N] line on every result; one failing command does not fail the call.`

const SECTION = `When a step has several independent commands, put all of them in one \`${TOOL_NAME}\` call rather than a few per call: the batch costs one step either way, so a narrow batch wastes the step.`

/** Join a relative per-command workdir onto the Session's directory. */
function resolveWorkdir(modelWorkdir, sessionCwd) {
  if (modelWorkdir === undefined) return sessionCwd
  if (sessionCwd !== undefined && !isAbsolute(modelWorkdir)) return `${sessionCwd}${sep}${modelWorkdir}`
  return modelWorkdir
}

/**
 * Run `worker` over `tasks` with at most `limit` in flight, preserving input
 * order. A tripped signal stops handing out new work; already-started commands
 * are killed by the shell executor through the signal they were given.
 */
async function runPool(tasks, limit, worker, signal) {
  const results = new Array(tasks.length)
  let next = 0
  const width = Math.max(1, Math.min(limit, tasks.length))
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      if (signal?.aborted === true) return
      const index = next
      next += 1
      if (index >= tasks.length) return
      results[index] = await worker(tasks[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** Per-command value for a command that settled through the shell executor. */
function settledValue(entry, spec, result) {
  return {
    command: entry.command,
    cwd: spec.workdir ?? '',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    timeoutMs: result.timeoutMs,
    stdout: { text: result.stdout.text, truncated: result.stdout.truncated },
    stderr: { text: result.stderr.text, truncated: result.stderr.truncated },
    ...result.sandbox === undefined
      ? {}
      : { sandbox: { mode: result.sandbox.mode, denied: result.sandbox.denied } }
  }
}

/** Per-command value for a command that never produced a process. */
function failedValue(entry, cwd, timeoutMs, error) {
  return {
    command: entry.command,
    cwd: cwd ?? '',
    exitCode: null,
    signal: null,
    timedOut: false,
    timeoutMs,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    error: String(error?.message ?? error)
  }
}

/** One command block: its command line, its output, then its status lines. */
function renderBlock(value, sessionCwd) {
  const lines = [`$ ${value.command}`]
  if (value.cwd !== undefined && value.cwd !== '' && value.cwd !== sessionCwd) lines.push(`[cwd: ${value.cwd}]`)
  const out = value.stdout.text.replace(/\n+$/, '')
  const err = value.stderr.text.replace(/\n+$/, '')
  if (out.length > 0) lines.push(out)
  if (err.length > 0) lines.push('[stderr]', err)
  if (out.length === 0 && err.length === 0 && value.error === undefined) lines.push('(no output)')
  if (value.stdout.truncated || value.stderr.truncated) lines.push('[output truncated]')
  if (value.sandbox?.denied === true) lines.push(SANDBOX_DENIAL(value.sandbox.mode))
  if (value.error !== undefined) lines.push(`[failed to start: ${value.error}]`)
  if (value.timedOut) lines.push(`[timed out after ${value.timeoutMs}ms]`)
  if (value.signal !== null) lines.push(`[killed by signal: ${value.signal}]`)
  else if (value.exitCode !== null) lines.push(`[exit code: ${value.exitCode}]`)
  return lines.join('\n')
}

/** Whether one command block reports a failure the summary counts. */
function isFailure(value) {
  return value.error !== undefined
    || value.timedOut
    || value.signal !== null
    || (value.exitCode !== null && value.exitCode !== 0)
}

function renderResult(value) {
  const blocks = value.results.map((entry) => renderBlock(entry, value.cwd))
  const failures = value.results.filter(isFailure).length
  const elapsed = Math.round(value.durationMs)
  const summary = failures === 0
    ? `[${value.results.length} commands ok · ${elapsed}ms]`
    : `[${value.results.length} commands · ${value.results.length - failures} ok, ${failures} failed · ${elapsed}ms]`
  return `${blocks.join('\n\n')}\n\n${summary}`
}

function presentCall(args) {
  const commands = Array.isArray(args?.commands) ? args.commands : []
  const lines = commands
    .map((entry) => (typeof entry?.command === 'string' ? `$ ${entry.command}` : ''))
    .filter((line) => line.length > 0)
  return {
    card: 'generic',
    title: commands.length > 0 ? `${commands.length} commands` : TOOL_NAME,
    kind: 'execute',
    rawInput: lines.join('\n'),
    content: [{ type: 'text', text: lines.join('\n') }]
  }
}

/** One captured stream: its text and whether the byte cap cut it. */
function streamSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      truncated: { type: 'boolean' }
    },
    required: ['text', 'truncated']
  }
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cwd: { type: 'string' },
    durationMs: { type: 'number' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          signal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          timeoutMs: { type: 'number' },
          stdout: streamSchema(),
          stderr: streamSchema(),
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string' },
              denied: { type: 'boolean' }
            },
            required: ['mode', 'denied']
          },
          error: { type: 'string' }
        },
        required: ['command', 'cwd', 'exitCode', 'signal', 'timedOut', 'timeoutMs', 'stdout', 'stderr']
      }
    }
  },
  required: ['cwd', 'durationMs', 'results']
}

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    commands: {
      type: 'array',
      description: `Independent commands to run at once, 2-${DEFAULTS.maxCommands}. Result order matches this order.`,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: {
            type: 'string',
            description: 'Bash command line, as it would be passed to `bash -c`.'
          },
          workdir: {
            type: 'string',
            description: "Directory to run in; a relative path resolves against the Session's current directory. Defaults to the Session's current directory."
          },
          timeoutMs: {
            type: 'number',
            description: 'Per-command wall-clock limit in milliseconds. The command is killed when it expires.'
          }
        },
        required: ['command']
      }
    },
    concurrency: {
      type: 'number',
      description: `How many commands may run at once. Defaults to ${DEFAULTS.maxConcurrency} and is capped there.`
    }
  },
  required: ['commands']
}

function apply(ctx, config = {}) {
  const maxCommands = Number.isInteger(config.maxCommands) && config.maxCommands > 0 ? config.maxCommands : DEFAULTS.maxCommands
  const maxConcurrency = Number.isInteger(config.maxConcurrency) && config.maxConcurrency > 0 ? config.maxConcurrency : DEFAULTS.maxConcurrency
  const toolTimeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULTS.timeoutMs

  // A confining executor requires the standing policy service; fail at load
  // rather than per call, exactly as the shipped bash tool does.
  const defaultMode = ctx.shell.sandboxMode
  const sandboxPolicy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
  if (defaultMode !== undefined && sandboxPolicy === undefined) {
    throw new Error('tool-bash-parallel: the mounted shell executor confines but ctx.sandboxPolicy is missing')
  }
  const resolveSandboxPolicy = (exec) =>
    sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })

  // Registered on the host plane, so every agent scope (and therefore every
  // session and preset) sees the guidance without per-preset wiring.
  ctx.systemPrompt.section({
    name: 'tool:bash-parallel',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
    text: SECTION
  })

  ctx.tools.register({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
      presentationMeta: (_args, value) => ({ cwd: value.cwd })
    },
    presentCall,
    // The batch owns its own fan-out. Staying exclusive keeps the registry's
    // scheduler from stacking a second pool on top of this one.
    isConcurrencySafe: () => false,
    timeoutMs: toolTimeoutMs,
    async execute(args, exec) {
      const entries = Array.isArray(args.commands) ? args.commands : []
      if (entries.length === 0) throw new Error('commands must contain at least one command')
      if (entries.length > maxCommands) {
        throw new Error(`commands must contain at most ${maxCommands} commands, got ${entries.length}`)
      }
      for (const [index, entry] of entries.entries()) {
        if (typeof entry?.command !== 'string' || entry.command.trim().length === 0) {
          throw new Error(`commands[${index}].command must be a non-empty string`)
        }
      }
      if (exec.signal.aborted) throw new Error('bash_parallel: aborted before start')

      const requested = typeof args.concurrency === 'number' && Number.isFinite(args.concurrency)
        ? Math.floor(args.concurrency)
        : maxConcurrency
      const concurrency = Math.max(1, Math.min(requested, maxConcurrency))

      const sessionCwd = exec.agent === undefined
        ? undefined
        : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const dshEnv = ctx.shellEnv.collect(exec)
      const policy = resolveSandboxPolicy(exec)
      const started = Date.now()

      const results = await runPool(entries, concurrency, async (entry) => {
        const workdir = resolveWorkdir(entry.workdir, sessionCwd)
        let spec
        try {
          spec = ctx.shell.resolve({
            command: entry.command,
            ...workdir === undefined ? {} : { workdir },
            ...entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs },
            dshEnv,
            ...policy === undefined ? {} : { sandboxPolicy: policy },
            signal: exec.signal
          })
        } catch (error) {
          return failedValue(entry, workdir ?? sessionCwd, entry.timeoutMs ?? 0, error)
        }
        try {
          const handle = await ctx.shell.execute(spec)
          return settledValue(entry, spec, await handle.result())
        } catch (error) {
          return failedValue(entry, spec.workdir, spec.timeoutMs, error)
        }
      }, exec.signal)

      return {
        cwd: sessionCwd ?? '',
        durationMs: Date.now() - started,
        results: results.filter((entry) => entry !== undefined)
      }
    }
  })
}

export { apply, inject, name }

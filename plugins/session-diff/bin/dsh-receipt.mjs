#!/usr/bin/env node
/** Entry point for the `dsh-receipt` command. */
import { run } from '../src/cli.mjs'

const code = await run(process.argv.slice(2), {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
})
process.exitCode = code

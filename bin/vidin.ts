#!/usr/bin/env node
import { main } from '../src/cli.ts';

process.exit(await main(process.argv.slice(2)));

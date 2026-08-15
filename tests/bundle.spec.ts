import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { DSH_HOST_VERSION } from '../src/constants.js'

const expression = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => ({ __jsExpr: value }),
})

describe('dsh-host bundle', () => {
  it('declares a parseable Host-only patch', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version?: string
      dsh?: { bundle?: { patch?: string } }
    }
    expect(DSH_HOST_VERSION).toBe(manifest.version)
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), {
      schema: yaml.DEFAULT_SCHEMA.extend([expression]),
    }) as Array<{ id?: string; insert?: Array<{ id?: string; name?: string }> }>
    const inserted = parsed.flatMap(item => item.insert ?? [])
    expect(inserted.find(row => row.id === 'webserver')?.name).toBe('dsh-host/server')
    expect(inserted.find(row => row.id === 'host-runtime')?.name).toBe('dsh-host')
    expect(inserted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'client-locale-contract',
        name: '@deepseek-ai/dsh-client-locale',
      }),
      expect.objectContaining({
        id: 'client-theme-contract',
        name: '@deepseek-ai/dsh-client-ui-theme',
      }),
      expect.objectContaining({
        id: 'client-conversation-contract',
        name: '@deepseek-ai/dsh-client-ui-conversation',
      }),
      expect.objectContaining({
        id: 'client-onboarding-contract',
        name: '@deepseek-ai/dsh-client-ui-settings-general',
      }),
      expect.objectContaining({
        id: 'client-deliverables-contract',
        name: '@deepseek-ai/dsh-client-ui-deliverables',
      }),
    ]))
    expect(inserted.some(row => row.name === '@deepseek-ai/dsh-client-modules')).toBe(false)
    expect(parsed.find(row => row.id === 'tool-bash')).toMatchObject({ disabled: true })
    expect(parsed.find(row => row.id === 'tool-pwsh')).toMatchObject({ disabled: true })
  })
})

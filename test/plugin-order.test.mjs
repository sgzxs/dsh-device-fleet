// Regression guard for the 1.12.0 activation failure: the plugin passed
// `signEvent: signEventWithRotation` into a constructor before that `const`
// arrow had been initialized, which threw a TDZ ReferenceError on activation.
// Host tests could not catch it because they never load the plugin entry point.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/plugin/index.js', import.meta.url), 'utf8')

test('plugin: callback helpers are defined before they are passed to constructors', () => {
  for (const name of ['currentRotationSeq', 'signEventWithRotation', 'signRemappedEvents']) {
    const definition = source.indexOf(`const ${name} =`)
    assert.ok(definition >= 0, `${name} must stay a top-level const arrow`)
    assert.equal(
      source.slice(0, definition).includes(name),
      false,
      `${name} is referenced before its definition (TDZ); move it above the first use`,
    )
  }

  // Any `signEvent: someIdentifier` option must point at an identifier that has
  // already been initialized. This is the exact shape that broke 1.12.0.
  for (const match of source.matchAll(/signEvent:\s*([A-Za-z_$][\w$]*)/g)) {
    const identifier = match[1]
    const definition = source.indexOf(`const ${identifier} =`)
    assert.ok(definition >= 0, `signEvent references unknown identifier ${identifier}`)
    assert.ok(
      definition < match.index,
      `signEvent references ${identifier} before its definition (TDZ at plugin activation)`,
    )
  }
})

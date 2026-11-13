// A stand-in for python/cf_deploy.py in jest: reads the same config on stdin and prints the same kind of JSON-line
// events, without calling any API. A resource with Properties.Fail = true fails and rolls back what was created;
// the config it received is written to $FAKE_ENGINE_CONFIG_OUT when set.
const { writeFileSync } = require('fs')

let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const config = JSON.parse(input)
  if (process.env.FAKE_ENGINE_CONFIG_OUT) writeFileSync(process.env.FAKE_ENGINE_CONFIG_OUT, JSON.stringify(config))
  const emit = event => process.stdout.write(JSON.stringify({ timestamp: Date.now() / 1000, ...event }) + '\n')
  emit({ stage: 'START', message: `${config.operation} stack ${config.stackName}` })
  // the real engine reports every parsed resource; these are not stack events
  if (config.templateBody) for (const id of Object.keys(JSON.parse(config.templateBody).Resources)) emit({ stage: 'PARSE', resource: id, status: 'parsed' })

  if (config.operation === 'DELETE') {
    for (const [id, r] of Object.entries(config.previousResources).reverse()) {
      emit({ stage: 'EXECUTE', resource: id, status: 'DELETE_IN_PROGRESS', resourceType: r.type, physicalId: r.physicalId })
      emit({ stage: 'EXECUTE', resource: id, status: 'DELETE_COMPLETE', resourceType: r.type, physicalId: r.physicalId })
    }
    emit({ stage: 'SUCCESS', stackStatus: 'DELETE_COMPLETE', resources: {} })
    return
  }

  const resources = {}
  for (const [id, r] of Object.entries(JSON.parse(config.templateBody).Resources)) {
    emit({ stage: 'EXECUTE', resource: id, status: 'CREATE_IN_PROGRESS', resourceType: r.Type })
    if (r.Properties && r.Properties.Fail) {
      emit({ stage: 'EXECUTE', resource: id, status: 'CREATE_FAILED', resourceType: r.Type, reason: 'Resource handler returned message: "boom"' })
      emit({ stage: 'ROLLBACK', message: 'Undoing changes...' })
      for (const [done, state] of Object.entries(resources).reverse()) {
        emit({ stage: 'ROLLBACK', resource: done, status: 'DELETE_COMPLETE', resourceType: state.type, physicalId: state.physicalId })
      }
      emit({ stage: 'ERROR', message: `${id}: boom`, stackStatus: 'ROLLBACK_COMPLETE', resources: {} })
      return
    }
    resources[id] = { type: r.Type, physicalId: `phys-${id}`, properties: r.Properties || {}, attributes: { Ref: `phys-${id}` } }
    emit({ stage: 'EXECUTE', resource: id, status: 'CREATE_COMPLETE', resourceType: r.Type, physicalId: `phys-${id}` })
  }
  emit({ stage: 'SUCCESS', stackStatus: 'CREATE_COMPLETE', resources })
})

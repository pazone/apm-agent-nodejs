'use strict'

const { URL } = require('url')

const OPERATIONS_TO_ACTIONS = {
  deleteMessage: 'delete',
  deleteMessageBatch: 'delete_batch',
  receiveMessage: 'poll',
  sendMessageBatch: 'send_batch',
  sendMessage: 'send',
  unknown: 'unknown'
}
const OPERATIONS = Object.keys(OPERATIONS_TO_ACTIONS)
const TYPE = 'messaging'
const SUBTYPE = 'sqs'
const queueMetrics = new Map()

// Returns Message Queue action from AWS SDK method name
function getActionFromRequest (request) {
  request = request || {}
  const operation = request.operation ? request.operation : 'unknown'
  const action = OPERATIONS_TO_ACTIONS[operation]

  return action
}

// Returns preposition to use in span name
//
// POLL from ...
// SEND to ...
function getToFromFromOperation (operation) {
  let result = 'from'
  if (operation === 'sendMessage' || operation === 'sendMessageBatch') {
    result = 'to'
  }
  return result
}

// Parses queue/topic name from AWS queue URL
function getQueueNameFromRequest (request) {
  const unknown = 'unknown'
  if (!request || !request.params || !request.params.QueueUrl) {
    return unknown
  }
  try {
    const url = new URL(request.params.QueueUrl)
    return url.pathname.split('/').pop()
  } catch (e) {
    return unknown
  }
}

// Parses region name from AWS service configuration
function getRegionFromRequest (request) {
  const region = request && request.service &&
    request.service.config && request.service.config.region
  return region || ''
}

// Creates message destination context suitable for setDestinationContext
function getMessageDestinationContextFromRequest (request) {
  const destination = {
    service: {
      name: SUBTYPE,
      resource: `${SUBTYPE}/${getQueueNameFromRequest(request)}`,
      type: TYPE
    },
    cloud: {
      region: getRegionFromRequest(request)
    }
  }
  return destination
}

// create message context suitable for setMessageContext
function getMessageContextFromRequest (request) {
  const message = {
    queue: {
      name: getQueueNameFromRequest(request)
    }
  }
  return message
}

// Record queue related metrics
//
// Creates metric collector objects on first run, and
// updates their data with data from received messages
function recordMetrics (queueName, data, agent) {
  const messages = data && data.Messages
  if (!messages || messages.length < 1) {
    return
  }
  if (!queueMetrics.get(queueName)) {
    const collector = agent._metrics.createQueueMetricsCollector(queueName)
    if (!collector) {
      return
    }
    queueMetrics.set(queueName, collector)
  }
  const metrics = queueMetrics.get(queueName)

  for (const message of messages) {
    const sentTimestamp = message.Attributes && message.Attributes.SentTimestamp
    const delay = (new Date()).getTime() - sentTimestamp
    metrics.updateStats(delay)
  }
}

// Creates the span name from request information
function getSpanNameFromRequest (request) {
  const action = getActionFromRequest(request)
  const toFrom = getToFromFromOperation(request.operation)
  const queueName = getQueueNameFromRequest(request)

  const name = `${SUBTYPE.toUpperCase()} ${action.toUpperCase()} ${toFrom} ${queueName}`
  return name
}

function shouldIgnoreRequest (request, agent) {
  const operation = request && request.operation
  // are we interested in this operation/method call?
  if (OPERATIONS.indexOf(operation) === -1) {
    return true
  }

  // is the named queue on our ignore list?
  if (agent._conf && agent._conf.ignoreMessageQueuesRegExp) {
    const queueName = getQueueNameFromRequest(request)
    for (const rule of agent._conf.ignoreMessageQueuesRegExp) {
      if (rule.test(queueName)) {
        return true
      }
    }
  }

  return false
}

// Main entrypoint for SQS instrumentation
//
// Must call (or one of its function calls must call) the
// `orig` function/method
function instrumentationSqs (orig, origArguments, request, AWS, agent, { version, enabled }) {
  if (shouldIgnoreRequest(request, agent)) {
    return orig.apply(request, origArguments)
  }

  const ins = agent._instrumentation
  const action = getActionFromRequest(request)
  const name = getSpanNameFromRequest(request)
  const span = ins.createSpan(name, TYPE, SUBTYPE, action, { exitSpan: true })
  if (!span) {
    return orig.apply(request, origArguments)
  }

  span.setDestinationContext(getMessageDestinationContextFromRequest(request))
  span.setMessageContext(getMessageContextFromRequest(request))

  const onComplete = function (response) {
    if (response && response.error) {
      agent.captureError(response.error)
    }

    span.end()

    if (request.operation === 'receiveMessage' && response && response.data) {
      recordMetrics(getQueueNameFromRequest(request), response.data, agent)
    }
  }
  // Bind onComplete to the span's run context so that `captureError` picks
  // up the correct currentSpan.
  const parentRunContext = ins.currRunContext()
  const spanRunContext = parentRunContext.enterSpan(span)
  request.on('complete', ins.bindFunctionToRunContext(spanRunContext, onComplete))

  const cb = origArguments[origArguments.length - 1]
  if (typeof cb === 'function') {
    origArguments[origArguments.length - 1] = ins.bindFunctionToRunContext(parentRunContext, cb)
  }
  return ins.withRunContext(spanRunContext, orig, request, ...origArguments)
}

module.exports = {
  instrumentationSqs,

  // exported for tests
  getToFromFromOperation,
  getActionFromRequest,
  getQueueNameFromRequest,
  getRegionFromRequest,
  getMessageDestinationContextFromRequest,
  shouldIgnoreRequest
}

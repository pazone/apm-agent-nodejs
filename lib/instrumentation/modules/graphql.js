'use strict'

var semver = require('semver')
var clone = require('shallow-clone-shim')

var getPathFromRequest = require('../express-utils').getPathFromRequest

module.exports = function (graphql, agent, { version, enabled }) {
  if (!enabled) return graphql
  if (!semver.satisfies(version, '>=0.7.0 <16.0.0 || ^14.0.0-rc') ||
      !graphql.Kind ||
      typeof graphql.Source !== 'function' ||
      typeof graphql.parse !== 'function' ||
      typeof graphql.validate !== 'function' ||
      typeof graphql.execute !== 'function') {
    agent.logger.debug('graphql version %s not supported - aborting...', version)
    return graphql
  }

  const ins = agent._instrumentation

  return clone({}, graphql, {
    graphql (descriptor) {
      const getter = descriptor.get
      if (getter) {
        descriptor.get = function get () {
          return wrapGraphql(getter())
        }
      }
      return descriptor
    },
    execute (descriptor) {
      const getter = descriptor.get
      if (getter) {
        descriptor.get = function get () {
          return wrapExecute(getter())
        }
      }
      return descriptor
    }
  })

  function wrapGraphql (orig) {
    return function wrappedGraphql (schema, requestString, rootValue, contextValue, variableValues, operationName) {
      agent.logger.debug('intercepted call to graphql.graphql')
      const span = ins.createSpan('GraphQL: Unknown Query', 'db', 'graphql', 'execute')
      if (!span) {
        return orig.apply(this, arguments)
      }

      var source = new graphql.Source(requestString || '', 'GraphQL request')
      if (source) {
        var documentAST

        try {
          documentAST = graphql.parse(source)
        } catch (syntaxError) {
          agent.logger.debug('graphql.parse(source) failed - skipping graphql query extraction')
        }

        if (documentAST) {
          var validationErrors = graphql.validate(schema, documentAST)
          if (validationErrors && validationErrors.length === 0) {
            var queries = extractDetails(documentAST, operationName).queries
            if (queries.length > 0) span.name = 'GraphQL: ' + queries.join(', ')
          }
        }
      } else {
        agent.logger.debug('graphql.Source(query) failed - skipping graphql query extraction')
      }

      const spanRunContext = ins.currRunContext().enterSpan(span)
      const p = ins.withRunContext(spanRunContext, orig, this, ...arguments)
      p.then(function () {
        span.end()
      })
      return p
    }
  }

  function wrapExecute (orig) {
    function wrappedExecuteImpl (schema, document, rootValue, contextValue, variableValues, operationName) {
      agent.logger.debug('intercepted call to graphql.execute')
      const span = ins.createSpan('GraphQL: Unknown Query', 'db', 'graphql', 'execute')
      if (!span) {
        agent.logger.debug('no active transaction found - skipping graphql tracing')
        return orig.apply(this, arguments)
      }

      var details = extractDetails(document, operationName)
      var queries = details.queries
      operationName = operationName || (details.operation && details.operation.name && details.operation.name.value)
      if (queries.length > 0) {
        span.name = 'GraphQL: ' + (operationName ? operationName + ' ' : '') + queries.join(', ')
      }

      // `_graphqlRoute` is a boolean set in instrumentations of other modules
      // that specify 'graphql' in peerDependencies (e.g. 'express-graphql') to
      // indicate that this transaction is for a GraphQL request.
      const trans = span.transaction
      if (trans._graphqlRoute) {
        var name = queries.length > 0 ? queries.join(', ') : 'Unknown GraphQL query'
        if (trans.req) var path = getPathFromRequest(trans.req, true)
        var defaultName = name
        defaultName = path ? defaultName + ' (' + path + ')' : defaultName
        defaultName = operationName ? operationName + ' ' + defaultName : defaultName
        trans.setDefaultName(defaultName)
        trans.type = 'graphql'
      }

      const spanRunContext = ins.currRunContext().enterSpan(span)
      const p = ins.withRunContext(spanRunContext, orig, this, ...arguments)
      if (typeof p.then === 'function') {
        p.then(function () {
          span.end()
        })
      } else {
        span.end()
      }
      return p
    }

    return function wrappedExecute (argsOrSchema, document, rootValue, contextValue, variableValues, operationName) {
      return arguments.length === 1
        ? wrappedExecuteImpl(
          argsOrSchema.schema,
          argsOrSchema.document,
          argsOrSchema.rootValue,
          argsOrSchema.contextValue,
          argsOrSchema.variableValues,
          argsOrSchema.operationName
        )
        : wrappedExecuteImpl(
          argsOrSchema,
          document,
          rootValue,
          contextValue,
          variableValues,
          operationName
        )
    }
  }

  function extractDetails (document, operationName) {
    var queries = []
    var operation

    if (document && Array.isArray(document.definitions)) {
      document.definitions.some(function (definition) {
        if (!definition || definition.kind !== graphql.Kind.OPERATION_DEFINITION) return
        if (!operationName && operation) return
        if (!operationName || (definition.name && definition.name.value === operationName)) {
          operation = definition
          return true
        }
      })

      var selections = operation && operation.selectionSet && operation.selectionSet.selections
      if (selections && Array.isArray(selections)) {
        for (const selection of selections) {
          const kind = selection.name && selection.name.kind
          if (kind === graphql.Kind.NAME) {
            const queryName = selection.name.value
            if (queryName) queries.push(queryName)
          }
        }

        queries = queries.sort(function (a, b) {
          if (a > b) return 1
          else if (a < b) return -1
          return 0
        })
      }
    } else {
      agent.logger.debug('unexpected document format - skipping graphql query extraction')
    }

    return { queries: queries, operation: operation }
  }
}

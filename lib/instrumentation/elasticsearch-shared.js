'use strict'

// Shared functionality between the instrumentations of:
// - elasticsearch - the legacy Elasticsearch JS client
// - @elastic/elasticsearch - the new Elasticsearch JS client

const querystring = require('querystring')

// URL paths matching the following pattern will have their query params and
// request body captured in the span (as `context.db.statement`). We match
// a complete URL path component to attempt to avoid accidental matches of
// user data, like `GET /my_index_search/...`.
const pathIsAQuery = /\/(_search|_msearch|_count|_async_search|_sql|_eql)(\/|$)/

// (This is exported for testing.)
exports.pathIsAQuery = pathIsAQuery

// Set the span's `context.db` from the Elasticsearch request querystring and
// body, if the request path looks like it is a query API.
//
// Some ES endpoints, e.g. '_search', support both query params and a body.
// We encode both into 'span.context.db.statement', separated by '\n\n'
// if both are present. E.g. for a possible msearch:
//
//    search_type=query_then_fetch&typed_keys=false
//
//    {}
//    {"query":{"query_string":{"query":"pants"}}}
//
// `path`, `query`, and `body` can all be null or undefined.
exports.setElasticsearchDbContext = function (span, path, query, body) {
  if (path && pathIsAQuery.test(path)) {
    const parts = []
    if (query) {
      if (typeof (query) === 'string') {
        parts.push(query)
      } else if (typeof (query) === 'object') {
        const encodedQuery = querystring.encode(query)
        if (encodedQuery) {
          parts.push(encodedQuery)
        }
      }
    }
    if (body) {
      if (typeof (body) === 'string') {
        parts.push(body)
      } else if (Buffer.isBuffer(body) || typeof body.pipe === 'function') {
        // Never serialize a Buffer or a Readable. These guards mirror
        // `shouldSerialize()` in the ES client, e.g.:
        // https://github.com/elastic/elastic-transport-js/blob/069172506d1fcd544b23747d8c2d497bab053038/src/Transport.ts#L614-L618
      } else if (Array.isArray(body)) {
        try {
          parts.push(body.map(JSON.stringify).join('\n') + '\n') // ndjson
        } catch (_ignoredErr) {}
      } else if (typeof (body) === 'object') {
        try {
          parts.push(JSON.stringify(body))
        } catch (_ignoredErr) {}
      }
    }

    span.setDbContext({
      type: 'elasticsearch',
      statement: parts.join('\n\n')
    })
  }
}

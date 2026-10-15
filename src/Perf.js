/**
 * Perf — one-line JSON timing logs (docs/API.md §4, « Perf »).
 *
 * Every line is console.log(JSON.stringify({...})), readable in the Apps Script Executions log and
 * in Cloud Logging (filter on jsonPayload / textPayload containing "stage" or "api"). Shapes:
 *   {api, ms, authMs, ok, code?}                          one per google.script.run call (apiWrap_)
 *   {stage:'sheet', tab, rows, ms}                        one full read of a data tab (Store)
 *   {stage:<name>, ms, <lap>: ms, ..., <field>: value}    a staged operation (Perf.start)
 * Lines carry durations, counts, tab / API names and month keys only: never an e-mail address, an id
 * or record contents. The overhead is a few Date.now() calls and one console.log per line.
 *
 * Load-order safe: the IIFE only defines functions.
 */
var Perf = (function () {

  /** Emits one JSON line; logging never breaks the caller. */
  function log(fields) {
    try {
      console.log(JSON.stringify(fields));
    } catch (e) { /* logging is best effort */ }
  }

  /**
   * Lap timer for a staged operation:
   *   var t = Perf.start('importMonth', {month: m}); ...; t.lap('readSource'); ...; t.end({changed: true});
   * lap(name) adds the time since the previous lap (or the start) to `name` (a name used twice
   * accumulates); end(extra) emits {stage, ms (total), laps..., fields..., extra...}. Call end() once,
   * when the stage completes.
   */
  function start(stage, fields) {
    var t0 = Date.now();
    var last = t0;
    var laps = {};
    return {
      lap: function (name) {
        var now = Date.now();
        laps[name] = (laps[name] || 0) + now - last;
        last = now;
      },
      end: function (extra) {
        var out = { stage: stage, ms: Date.now() - t0 };
        [laps, fields, extra].forEach(function (o) {
          Object.keys(o || {}).forEach(function (k) { out[k] = o[k]; });
        });
        log(out);
      }
    };
  }

  return {
    log: log,
    start: start
  };
})();
